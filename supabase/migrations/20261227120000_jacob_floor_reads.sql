-- Jacob (floor staff) must not receive sold-item money or the shipped order list.
-- Admins keep the full payload. Scan-out matches a SKU or a tracking number,
-- refuses the wrong status without writing, and ships through portal_mark_order_shipped.

begin;

create or replace function public.floor_clerk_inventory_payload(p jsonb, p_admin boolean)
returns jsonb
language plpgsql
stable
as $$
declare
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
begin
  if p_admin or p is null then
    return p;
  end if;
  for v_item in select value from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb))
  loop
    if coalesce(v_item->>'state', '') = 'sold' then
      v_item := v_item - 'ask_cents' - 'acquisition_cost_cents' - 'sold_price_cents'
        - 'retail_cents' - 'cost_cents' - 'profit_cents' - 'fee_cents';
      if v_item ? 'group_members' and jsonb_typeof(v_item->'group_members') = 'array' then
        v_item := jsonb_set(v_item, '{group_members}', coalesce((
          select jsonb_agg(m - 'ask_cents' - 'acquisition_cost_cents' - 'sold_price_cents'
            - 'retail_cents' - 'cost_cents' - 'profit_cents' - 'fee_cents')
          from jsonb_array_elements(v_item->'group_members') m
        ), '[]'::jsonb));
      end if;
    else
      v_item := v_item - 'acquisition_cost_cents' - 'sold_price_cents';
    end if;
    v_items := v_items || jsonb_build_array(v_item);
  end loop;
  return jsonb_set(
    jsonb_set(p, '{items}', v_items),
    '{totals}',
    coalesce(p->'totals', '{}'::jsonb) - 'retail_cents' - 'cost_cents' - 'missing_cost'
  );
end $$;

revoke all on function public.floor_clerk_inventory_payload(jsonb, boolean) from public, anon, authenticated;

do $$
declare
  src text;
  next text;
begin
  select pg_get_functiondef('public.receive_inventory_list(text,text,boolean,text,int,int,text)'::regprocedure) into src;
  next := replace(src, 'return v_result;', 'return public.floor_clerk_inventory_payload(v_result, v_admin);');
  if next = src then
    raise exception 'receive_inventory_list return site changed';
  end if;
  execute next;
end $$;

create or replace function public.staff_inventory_detail(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.current_store_id(); v_result jsonb;
begin
  if v_store is null or not exists (
    select 1 from public.staff s where s.user_id = auth.uid() and s.store_id = v_store and s.deactivated_at is null
  ) then raise exception 'staff_access_denied' using errcode = '42501'; end if;
  select jsonb_build_object(
    'unit', jsonb_build_object('sku', u.sku, 'brand', u.brand, 'model', u.model, 'title', u.title, 'category', u.category,
      'condition', u.condition, 'test_status', u.test_status, 'location', u.location, 'ask_cents',
      case when u.state in ('available', 'reserved', 'repair') then u.ask_cents end,
      'state', u.state, 'show_on_website', u.show_on_website, 'received_at', u.received_at, 'updated_at', u.updated_at,
      'package_weight_lb', u.package_weight_lb, 'package_length_in', u.package_length_in,
      'package_width_in', u.package_width_in, 'package_height_in', u.package_height_in, 'upc', u.upc,
      'listing_body', u.listing_body, 'defect_notes', u.defect_notes,
      'qty_on_hand', u.qty_on_hand, 'is_stocked', u.is_stocked,
      'shippable', u.shippable, 'fulfillment_override', u.fulfillment_override,
      'listing_specs', u.listing_specs),
    'photos', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'path', p.path, 'is_primary', p.is_primary)
      order by p.is_primary desc, p.id) from public.photos p where p.store_id = u.store_id and p.sku = u.sku), '[]'::jsonb),
    'listings', coalesce((select jsonb_agg(jsonb_build_object('channel', l.channel, 'status', l.status, 'listing_id', l.listing_id)
      order by l.channel) from public.listings l where l.store_id = u.store_id and l.sku = u.sku), '[]'::jsonb)
  ) into v_result from public.units u where u.store_id = v_store and u.sku = p_sku;
  if v_result is null then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  if (v_result #>> '{unit,state}') = 'sold' then
    v_result := jsonb_set(v_result, '{unit}', (v_result->'unit') - 'ask_cents');
  end if;
  return v_result;
end $$;

create or replace function public.portal_web_orders(p_days integer default 90)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_income_pct numeric;
  v_admin boolean := public.portal_is_admin();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_income_pct := coalesce(
    (public.store_setting(v_store, 'income_tax_pct', '25'::jsonb) #>> '{}')::numeric,
    25
  );
  return coalesce((select jsonb_agg(
    case when v_admin then to_jsonb(x)
    else to_jsonb(x)
      - 'item_cents' - 'shipping_cents' - 'tax_cents' - 'total_cents'
      - 'label_cost_cents' - 'marketplace_fee_cents' - 'fee_cents' - 'fee_source'
      - 'cost_cents' - 'profit_cents' - 'income_tax_cents'
      - 'tax_collected_cents' - 'tax_owed_cents' - 'shipping_rate'
    end
    order by x.created_at desc) from (
    select o.id, o.order_no, o.sku, o.status, o.fulfillment, o.channel,
      o.buyer_name, o.buyer_email, o.buyer_phone,
      o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal,
      o.item_cents, o.shipping_cents, o.tax_cents, o.total_cents,
      o.payment_id, o.refund_id, o.payment_env, o.created_at, o.paid_at,
      o.pickup_deadline, o.picked_up_at, o.picked_up_by,
      o.boxed_at, o.shipped_at, o.delivered_at,
      o.packaged_at, o.packaged_by, o.packaged_by_name,
      o.shipped_by, o.shipped_by_name, o.delivered_by, o.delivered_by_name,
      o.scanned_out_at, o.scanned_out_by_name,
      o.tracking_number, o.tracking_url, o.carrier, o.service, o.shipping_rate, o.label_url,
      o.label_purchased_at, o.label_cost_cents, o.refund_requested_at,
      o.label_storage_path, o.label_file_name, o.label_mime, o.label_uploaded_at, o.label_origin,
      o.tracking_status, o.tracking_exception, o.tracking_needs_entry, o.shippo_track_id,
      o.marketplace_tracking_number, o.label_tracking_mismatch, o.ebay_seller_username,
      o.cancel_source, o.cancel_reason, o.canceled_at, o.ship_by,
      o.pack_condition, o.pack_condition_at,
      o.pack_proof_photo_path, o.pack_proof_serial, o.pack_proof_at,
      o.match_status, o.marketplace_fee_cents, o.marketplace_title,
      o.sale_id,
      case when o.sale_id is not null
        then coalesce(sl.ticket_id::text, 'sale:' || o.sale_id::text)
        else null end as ticket_key,
      coalesce(nullif(btrim(o.marketplace_title), ''), nullif(btrim(u.title), ''),
        nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
      coalesce(u.listed_on, '{}'::text[]) as listed_on,
      coalesce(co.fee_cents, o.marketplace_fee_cents, sl.channel_fee_cents) as fee_cents,
      coalesce(
        co.fee_source,
        case
          when co.fee_cents is null and o.marketplace_fee_cents is null and sl.fee_source is not null
            then sl.fee_source
          when co.fee_cents is null and o.marketplace_fee_cents is not null then 'estimated'
          else null
        end
      ) as fee_source,
      sl.cost_cents,
      sl.profit_cents,
      case when sl.profit_cents is null then null
        else greatest(0, round(sl.profit_cents * v_income_pct / 100.0))::int end as income_tax_cents,
      sl.tax_remitted_by,
      coalesce(sl.tax_collected_cents, o.tax_cents, 0) as tax_collected_cents,
      coalesce(sl.tax_owed_cents, 0) as tax_owed_cents,
      case
        when lower(o.channel) = 'ebay' and o.order_no is not null
          then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
        when lower(o.channel) = 'amazon' and o.order_no is not null
          then 'https://sellercentral.amazon.com/orders-v3/order/' || o.order_no
        when lower(o.channel) = 'tiktok' and o.order_no is not null
          then 'https://seller-us.tiktok.com/order/detail?order_no=' || o.order_no
        when lower(o.channel) = 'depop' and o.order_no is not null
          then 'https://www.depop.com/sellinghub/sold/'
        when lower(o.channel) = 'mercari' and o.order_no is not null
          then 'https://www.mercari.com/mypage/listings/completed/'
        when lower(o.channel) in ('website','web') and o.order_no is not null
          then 'https://openboxindustries.com/account/orders/' || o.order_no
        else null
      end as marketplace_url,
      jsonb_build_object(
        'length_in', u.package_length_in,
        'width_in', u.package_width_in,
        'height_in', u.package_height_in,
        'weight_lb', u.package_weight_lb
      ) as package
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    left join public.channel_orders co
      on co.store_id = o.store_id and co.provider = o.channel and co.order_id = o.order_no
    left join public.sale_ledger sl on sl.id = o.sale_id
    where o.store_id = v_store
      and o.created_at > now() - make_interval(days => greatest(p_days, 1))
      and (o.status in ('paid', 'refunded', 'canceled') or o.paid_at is not null)
      and coalesce(o.payment_env, 'production') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
      and lower(coalesce(o.ebay_seller_username, '')) <> 'pgg124-5'
      and (
        v_admin
        or (
          o.shipped_at is null
          and o.delivered_at is null
          and o.canceled_at is null
          and o.status = 'paid'
          and not public.order_needs_label(
            o.status, o.channel, o.fulfillment, o.packaged_at, o.shipped_at, o.delivered_at,
            o.label_storage_path, o.label_origin, o.label_url, o.label_tracking_mismatch
          )
        )
      )
  ) x), '[]'::jsonb);
end $$;

-- Tracking match wins. Otherwise the barcode is a SKU: the oldest packaged, unshipped order.
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
  o public.web_orders;
begin
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

create or replace function public.portal_scan_out_lookup(p_barcode text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  o public.web_orders;
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  o := public.floor_scan_out_find(v_store, p_barcode);
  if o is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if o.canceled_at is not null or o.refund_requested_at is not null then
    return jsonb_build_object('ok', false, 'error', 'not_shippable', 'order_id', o.id);
  end if;
  if o.shipped_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_shipped', 'order_id', o.id, 'sku', o.sku);
  end if;
  if o.packaged_at is null then
    return jsonb_build_object('ok', false, 'error', 'not_packaged', 'order_id', o.id, 'sku', o.sku);
  end if;
  return jsonb_build_object('ok', true, 'order', jsonb_build_object(
    'id', o.id, 'order_no', o.order_no, 'sku', o.sku, 'title', o.marketplace_title,
    'channel', o.channel, 'packaged_at', o.packaged_at, 'shipped_at', o.shipped_at,
    'tracking_number', o.tracking_number, 'carrier', o.carrier));
end $$;

create or replace function public.portal_scan_out_commit(p_barcode text, p_mode text default 'ship')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_norm text := public.floor_normalize_tracking(p_barcode);
  v_name text := public.disposition_actor_name(auth.uid());
  v_mode text := lower(btrim(coalesce(p_mode, 'ship')));
  v_key text;
  o public.web_orders;
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_norm is null then raise exception 'empty_barcode' using errcode = '22023'; end if;
  if v_mode not in ('ship', 'package') then raise exception 'invalid_scan_mode' using errcode = '22023'; end if;
  o := public.floor_scan_out_find(v_store, p_barcode);
  if o is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  select * into o from public.web_orders where id = o.id and store_id = v_store for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if o.refund_requested_at is not null or o.canceled_at is not null then
    return jsonb_build_object('ok', false, 'error', 'not_shippable', 'order_id', o.id);
  end if;
  if v_mode = 'package' then
    if o.packaged_at is null then
      update public.web_orders set packaged_at = now(), packaged_by = auth.uid(), packaged_by_name = v_name,
        boxed_at = coalesce(boxed_at, now()), updated_at = now()
       where id = o.id;
    end if;
    v_key := 'pkg:' || o.id::text;
    insert into public.shipment_scan_events(store_id, order_id, tracking_raw, tracking_normalized, carrier, scan_mode, scanned_by, scanned_by_name)
    values (v_store, o.id, btrim(p_barcode), v_key, o.carrier, 'package', auth.uid(), v_name)
    on conflict (store_id, tracking_normalized) do nothing;
    return jsonb_build_object('ok', true, 'mode', 'package', 'order_id', o.id, 'sku', o.sku,
      'title', o.marketplace_title, 'packaged', true);
  end if;
  if o.shipped_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_shipped', 'order_id', o.id, 'sku', o.sku,
      'title', o.marketplace_title);
  end if;
  if o.packaged_at is null then
    return jsonb_build_object('ok', false, 'error', 'not_packaged', 'order_id', o.id, 'sku', o.sku,
      'title', o.marketplace_title);
  end if;
  -- Same write as the Mark shipped button: shipped_at, shipped_by, and the status event.
  perform public.portal_mark_order_shipped(o.id);
  update public.web_orders set
    scanned_out_at = now(),
    scanned_out_by = auth.uid(),
    scanned_out_by_name = v_name,
    updated_at = now()
  where id = o.id;
  v_key := case
    when public.floor_normalize_tracking(o.tracking_number) = v_norm
      or public.floor_normalize_tracking(o.marketplace_tracking_number) = v_norm
      then v_norm
    else 'sku:' || o.id::text
  end;
  insert into public.shipment_scan_events(store_id, order_id, tracking_raw, tracking_normalized, carrier, scan_mode, scanned_by, scanned_by_name)
  values (v_store, o.id, btrim(p_barcode), v_key, o.carrier, 'ship', auth.uid(), v_name);
  return jsonb_build_object('ok', true, 'mode', 'ship', 'order_id', o.id, 'shipped', true,
    'sku', o.sku, 'title', coalesce(nullif(btrim(o.marketplace_title), ''), o.sku));
end $$;

create or replace function public.portal_scan_out_undo()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  e public.shipment_scan_events;
  o public.web_orders;
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into e from public.shipment_scan_events s
   where s.store_id = v_store and s.scanned_by = auth.uid() and s.scan_mode = 'ship'
   order by s.scanned_at desc
   limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'nothing_to_undo'); end if;
  select * into o from public.web_orders where id = e.order_id and store_id = v_store for update;
  if not found or o.delivered_at is not null then
    return jsonb_build_object('ok', false, 'error', 'cannot_undo');
  end if;
  if o.shipped_by is distinct from auth.uid() or o.scanned_out_by is distinct from auth.uid() then
    return jsonb_build_object('ok', false, 'error', 'cannot_undo');
  end if;
  delete from public.events
   where store_id = v_store and sku = o.sku and field = 'order_marked_shipped'
     and actor_id = auth.uid() and new_value = o.shipped_at::text;
  update public.web_orders set
    shipped_at = null,
    shipped_by = null,
    shipped_by_name = null,
    scanned_out_at = null,
    scanned_out_by = null,
    scanned_out_by_name = null,
    updated_at = now()
  where id = o.id;
  delete from public.shipment_scan_events where id = e.id;
  return jsonb_build_object('ok', true, 'order_id', o.id, 'sku', o.sku,
    'title', coalesce(nullif(btrim(o.marketplace_title), ''), o.sku));
end $$;

create or replace function public.portal_scan_out_today()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_admin boolean := public.portal_is_admin();
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', e.id, 'order_id', e.order_id, 'sku', o.sku, 'title', o.marketplace_title,
      'tracking_normalized', e.tracking_normalized, 'scanned_at', e.scanned_at,
      'scanned_by_name', e.scanned_by_name, 'scan_mode', e.scan_mode)
    order by e.scanned_at desc)
    from public.shipment_scan_events e
    join public.web_orders o on o.id = e.order_id
    where e.store_id = v_store and (e.scanned_at at time zone 'America/Los_Angeles')::date = v_day
      and (v_admin or e.scanned_by = auth.uid())), '[]'::jsonb);
end $$;

revoke all on function public.portal_scan_out_undo() from public, anon;
grant execute on function public.portal_scan_out_undo() to authenticated;

commit;
