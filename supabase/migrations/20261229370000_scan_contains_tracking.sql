-- A scan matches when the saved tracking number sits inside it.
-- Parentheses stay out of the way, and the digits inside them stay.
-- A number under 18 characters is not a contains match, so a ZIP or a
-- 12-digit tail cannot scan out a different package. Two different long
-- numbers in one scan match nothing.

begin;

create or replace function public.floor_scan_contains_tracking(p_scan text, p_stored text)
returns boolean
language sql
immutable
as $$
  select coalesce(char_length(public.floor_normalize_tracking(p_stored)), 0) >= 18
    and position(
      public.floor_normalize_tracking(p_stored)
      in upper(regexp_replace(coalesce(p_scan, ''), '[^0-9A-Za-z]', '', 'g'))
    ) > 0;
$$;

revoke all on function public.floor_scan_contains_tracking(text, text) from public, anon;
grant execute on function public.floor_scan_contains_tracking(text, text) to authenticated, service_role;

create or replace function public.floor_scan_out_find(p_store uuid, p_barcode text)
returns public.web_orders
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_norm text := public.floor_normalize_tracking(p_barcode);
  v_suffix text;
  v_sku text := btrim(coalesce(p_barcode, ''));
  v_long text[];
  o public.web_orders;
begin
  if coalesce(v_norm, '') = '' and v_sku = '' then
    return null;
  end if;
  if v_norm is not null and char_length(v_norm) >= 18 then
    select coalesce(array_agg(distinct n), '{}') into v_long
    from (
      select public.floor_normalize_tracking(wo.tracking_number) as n
      from public.web_orders wo
      where wo.store_id = p_store
        and wo.fulfillment = 'ship'
        and wo.status in ('paid', 'refunded')
        and (
          public.floor_normalize_tracking(wo.tracking_number) = v_norm
          or public.floor_scan_contains_tracking(p_barcode, wo.tracking_number)
        )
      union
      select public.floor_normalize_tracking(wo.marketplace_tracking_number)
      from public.web_orders wo
      where wo.store_id = p_store
        and wo.fulfillment = 'ship'
        and wo.status in ('paid', 'refunded')
        and (
          public.floor_normalize_tracking(wo.marketplace_tracking_number) = v_norm
          or public.floor_scan_contains_tracking(p_barcode, wo.marketplace_tracking_number)
        )
    ) hits
    where n is not null and char_length(n) >= 18;
    if coalesce(array_length(v_long, 1), 0) > 1 then
      return null;
    end if;
    if coalesce(array_length(v_long, 1), 0) = 1 then
      select * into o from public.web_orders wo
       where wo.store_id = p_store
         and wo.fulfillment = 'ship'
         and wo.status in ('paid', 'refunded')
         and (
           public.floor_normalize_tracking(wo.tracking_number) = v_long[1]
           or public.floor_normalize_tracking(wo.marketplace_tracking_number) = v_long[1]
         )
       order by wo.paid_at desc nulls last, wo.created_at desc
       limit 1;
      return o;
    end if;
    return null;
  end if;
  if v_norm is null then
    return null;
  end if;
  v_suffix := right(v_norm, 12);
  select * into o from public.web_orders wo
   where wo.store_id = p_store
     and wo.fulfillment = 'ship'
     and wo.status in ('paid', 'refunded')
     and (
       public.floor_normalize_tracking(wo.tracking_number) = v_norm
       or public.floor_normalize_tracking(wo.marketplace_tracking_number) = v_norm
       or (
         length(v_suffix) >= 12
         and (
           right(regexp_replace(upper(coalesce(wo.tracking_number, '')), '\s+', '', 'g'), 12) = v_suffix
           or right(regexp_replace(upper(coalesce(wo.marketplace_tracking_number, '')), '\s+', '', 'g'), 12) = v_suffix
         )
       )
     )
   order by wo.paid_at desc nulls last, wo.created_at desc
   limit 1;
  if found then
    return o;
  end if;
  select * into o from public.web_orders wo
   where wo.store_id = p_store
     and wo.fulfillment = 'ship'
     and wo.status = 'paid'
     and wo.sku = v_sku
     and wo.canceled_at is null
     and wo.refund_requested_at is null
   order by
     (wo.packaged_at is not null and wo.shipped_at is null) desc,
     wo.packaged_at asc nulls last,
     wo.created_at asc
   limit 1;
  return o;
end $$;

revoke all on function public.floor_scan_out_find(uuid, text) from public, anon, authenticated;

create or replace function public.portal_mark_order_shipped(
  p_order uuid,
  p_barcode text default null,
  p_override_reason text default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_admin boolean := public.portal_is_admin();
  o public.web_orders;
  v_name text;
  v_at timestamptz;
  v_norm text;
  v_order_norm text;
  v_mkt_norm text;
  v_override text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_sku_scan boolean;
  v_hit boolean;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status <> 'paid' or o.fulfillment <> 'ship' or o.refund_requested_at is not null then
    raise exception 'order_not_shippable' using errcode = 'P0001';
  end if;
  if o.packaged_at is null then raise exception 'order_not_packaged' using errcode = 'P0001'; end if;
  if o.delivered_at is not null then raise exception 'order_already_delivered' using errcode = 'P0001'; end if;
  if o.shipped_at is not null then return; end if;

  v_order_norm := public.floor_normalize_tracking(o.tracking_number);
  v_mkt_norm := public.floor_normalize_tracking(o.marketplace_tracking_number);
  v_norm := public.floor_normalize_tracking(p_barcode);
  v_sku_scan := btrim(coalesce(p_barcode, '')) = o.sku;
  v_hit := v_order_norm is not null and v_order_norm is not distinct from v_norm
    or v_mkt_norm is not null and v_mkt_norm is not distinct from v_norm
    or public.floor_scan_contains_tracking(p_barcode, o.tracking_number)
    or public.floor_scan_contains_tracking(p_barcode, o.marketplace_tracking_number);

  if not v_sku_scan then
  if not v_admin then
    if v_override is not null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
    if v_norm is null then raise exception 'tracking_required' using errcode = 'P0001'; end if;
    if not v_hit then raise exception 'tracking_mismatch' using errcode = 'P0001'; end if;
  else
    if v_order_norm is null and v_mkt_norm is null then
      if v_norm is null and v_override is null then
        raise exception 'override_reason_required' using errcode = 'P0001';
      end if;
    elsif v_norm is not null and not v_hit then
      raise exception 'tracking_mismatch' using errcode = 'P0001';
    end if;
  end if;
  end if;

  v_name := public.disposition_actor_name(auth.uid());
  update public.web_orders set
    shipped_at = now(),
    shipped_by = auth.uid(),
    shipped_by_name = v_name,
    updated_at = now()
  where id = p_order
  returning shipped_at into v_at;
  insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
  values (v_store, o.sku, 'edit', 'order_marked_shipped', v_at::text, v_name, auth.uid(),
    format('Order %s marked shipped.%s',
      coalesce(o.order_no, o.id::text),
      case when v_override is not null then ' Override: ' || v_override else '' end));
end $$;

revoke all on function public.portal_mark_order_shipped(uuid, text, text) from public, anon;
grant execute on function public.portal_mark_order_shipped(uuid, text, text) to authenticated, service_role;

create or replace function public.portal_bundle_ship_peers(p_order uuid, p_barcode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_name text := public.disposition_actor_name(auth.uid());
  lead public.web_orders;
  peer public.web_orders;
  v_norm text := public.floor_normalize_tracking(p_barcode);
  v_prev_track text;
  v_prev_mkt text;
  shipped int := 0;
  skus jsonb := '[]'::jsonb;
  left_unpackaged jsonb := '[]'::jsonb;
begin
  if v_store is null or not public.is_staff() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into lead from public.web_orders where id = p_order and store_id = v_store;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if lead.shipped_at is null then raise exception 'lead_not_shipped' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_barcode, '')) = lead.sku then
    return jsonb_build_object('ok', true, 'shipped', 0, 'skus', skus, 'left_unpackaged', left_unpackaged);
  end if;
  if not (
    public.floor_normalize_tracking(lead.tracking_number) is not null
      and public.floor_normalize_tracking(lead.tracking_number) is not distinct from v_norm
    or public.floor_normalize_tracking(lead.marketplace_tracking_number) is not null
      and public.floor_normalize_tracking(lead.marketplace_tracking_number) is not distinct from v_norm
    or public.floor_scan_contains_tracking(p_barcode, lead.tracking_number)
    or public.floor_scan_contains_tracking(p_barcode, lead.marketplace_tracking_number)
  ) then
    raise exception 'tracking_mismatch' using errcode = 'P0001';
  end if;
  v_norm := coalesce(
    public.floor_normalize_tracking(lead.tracking_number),
    public.floor_normalize_tracking(lead.marketplace_tracking_number),
    v_norm
  );

  for peer in
    select w.* from public.web_orders w
    where w.store_id = v_store
      and w.id <> lead.id
      and w.shipped_at is null
      and w.canceled_at is null
      and w.refund_requested_at is null
      and coalesce(w.fulfillment, 'ship') = 'ship'
      and lower(coalesce(w.channel, '')) = lower(coalesce(lead.channel, ''))
      and public.bundle_addr(w.buyer_name) = public.bundle_addr(lead.buyer_name)
      and public.bundle_addr(lead.buyer_name) <> ''
      and not exists (select 1 from public.bundle_splits s where s.store_id = v_store and s.order_id = w.id)
      and (
        (
          public.bundle_addr(w.ship_line1) = public.bundle_addr(lead.ship_line1)
          and public.bundle_addr(w.ship_line2) = public.bundle_addr(lead.ship_line2)
          and public.bundle_addr(w.ship_city) = public.bundle_addr(lead.ship_city)
          and public.bundle_addr(w.ship_region) = public.bundle_addr(lead.ship_region)
          and public.bundle_addr(w.ship_postal) = public.bundle_addr(lead.ship_postal)
          and public.bundle_addr(lead.ship_line1) <> ''
          and public.bundle_addr(lead.ship_postal) <> ''
        )
        or exists (
          select 1 from public.bundle_links l
          where l.store_id = v_store
            and ((l.order_id = lead.id and l.peer_id = w.id) or (l.order_id = w.id and l.peer_id = lead.id))
        )
      )
  loop
    if peer.packaged_at is null then
      left_unpackaged := left_unpackaged || jsonb_build_array(peer.sku);
      continue;
    end if;
    v_prev_track := peer.tracking_number;
    v_prev_mkt := peer.marketplace_tracking_number;
    update public.web_orders set
      tracking_number = v_norm,
      marketplace_tracking_number = v_norm,
      carrier = coalesce(peer.carrier, lead.carrier),
      updated_at = now()
    where id = peer.id;
    begin
      perform public.portal_mark_order_shipped(peer.id, p_barcode);
    exception when others then
      update public.web_orders set
        tracking_number = v_prev_track,
        marketplace_tracking_number = v_prev_mkt,
        updated_at = now()
      where id = peer.id;
      left_unpackaged := left_unpackaged || jsonb_build_array(peer.sku);
      continue;
    end;
    update public.web_orders set
      scanned_out_at = now(),
      scanned_out_by = auth.uid(),
      scanned_out_by_name = v_name,
      updated_at = now()
    where id = peer.id;
    insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
    values (v_store, peer.sku, 'edit', 'order_marked_shipped', now()::text, v_name, auth.uid(),
      format('Shipped with order %s as one box.', coalesce(lead.order_no, left(lead.id::text, 8))));
    shipped := shipped + 1;
    skus := skus || jsonb_build_array(peer.sku);
  end loop;
  return jsonb_build_object('ok', true, 'shipped', shipped, 'skus', skus, 'left_unpackaged', left_unpackaged);
end $$;

revoke all on function public.portal_bundle_ship_peers(uuid, text) from public, anon;
grant execute on function public.portal_bundle_ship_peers(uuid, text) to authenticated, service_role;

commit;
