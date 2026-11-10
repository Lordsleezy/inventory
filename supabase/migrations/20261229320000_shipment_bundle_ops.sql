-- Manual checkbox Bundle / Unbundle for Needs label and To ship.
-- Links require the same buyer and the same ship-to. A label blocks both.

begin;

create or replace function public.portal_bundle_orders(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_ids uuid[] := coalesce(p_ids, '{}');
  lead public.web_orders;
  peer public.web_orders;
  i int;
  j int;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if cardinality(v_ids) < 2 then
    raise exception 'need_two' using errcode = 'P0001';
  end if;

  select * into lead
  from public.web_orders
  where store_id = v_store and id = v_ids[1];
  if lead.id is null then raise exception 'order_not_found' using errcode = 'P0001'; end if;

  for i in 1 .. cardinality(v_ids) loop
    select * into peer from public.web_orders where store_id = v_store and id = v_ids[i];
    if peer.id is null then raise exception 'order_not_found' using errcode = 'P0001'; end if;
    if peer.status is distinct from 'paid'
       or coalesce(peer.fulfillment, 'ship') is distinct from 'ship'
       or peer.canceled_at is not null
       or peer.shipped_at is not null then
      raise exception 'not_open' using errcode = 'P0001';
    end if;
    if peer.label_storage_path is not null
       or peer.label_uploaded_at is not null
       or peer.label_purchased_at is not null
       or peer.label_url is not null then
      raise exception 'label_exists' using errcode = 'P0001';
    end if;
    if i = 1 then continue; end if;
    if lower(coalesce(peer.channel, '')) <> lower(coalesce(lead.channel, '')) then
      raise exception 'different_channel' using errcode = 'P0001';
    end if;
    if public.bundle_addr(lead.buyer_name) = ''
       or public.bundle_addr(lead.buyer_name) <> public.bundle_addr(peer.buyer_name) then
      raise exception 'different_buyer' using errcode = 'P0001';
    end if;
    if public.bundle_addr(lead.ship_line1) = ''
       or public.bundle_addr(lead.ship_postal) = ''
       or public.bundle_addr(lead.ship_line1) <> public.bundle_addr(peer.ship_line1)
       or public.bundle_addr(coalesce(lead.ship_line2, '')) <> public.bundle_addr(coalesce(peer.ship_line2, ''))
       or public.bundle_addr(lead.ship_city) <> public.bundle_addr(peer.ship_city)
       or public.bundle_addr(lead.ship_region) <> public.bundle_addr(peer.ship_region)
       or public.bundle_addr(lead.ship_postal) <> public.bundle_addr(peer.ship_postal) then
      raise exception 'different_address' using errcode = 'P0001';
    end if;
  end loop;

  delete from public.bundle_splits where store_id = v_store and order_id = any (v_ids);

  for i in 1 .. cardinality(v_ids) loop
    for j in i + 1 .. cardinality(v_ids) loop
      insert into public.bundle_links (store_id, order_id, peer_id)
      values (v_store, v_ids[i], v_ids[j])
      on conflict do nothing;
      insert into public.bundle_links (store_id, order_id, peer_id)
      values (v_store, v_ids[j], v_ids[i])
      on conflict do nothing;
    end loop;
  end loop;

  insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
  select v_store, w.sku, 'edit', 'order_bundled', array_to_string(v_ids, ','),
         public.disposition_actor_name(auth.uid()), auth.uid(),
         format('Manual bundle of %s items.', cardinality(v_ids))
  from public.web_orders w
  where w.store_id = v_store and w.id = v_ids[1];

  return jsonb_build_object('ok', true, 'count', cardinality(v_ids), 'ids', to_jsonb(v_ids));
end $$;

revoke all on function public.portal_bundle_orders(uuid[]) from public, anon;
grant execute on function public.portal_bundle_orders(uuid[]) to authenticated, service_role;

create or replace function public.portal_unbundle_orders(p_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_ids uuid[] := coalesce(p_ids, '{}');
  peer public.web_orders;
  i int;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if cardinality(v_ids) < 1 then
    raise exception 'need_one' using errcode = 'P0001';
  end if;

  for i in 1 .. cardinality(v_ids) loop
    select * into peer from public.web_orders where store_id = v_store and id = v_ids[i];
    if peer.id is null then raise exception 'order_not_found' using errcode = 'P0001'; end if;
    if peer.label_storage_path is not null
       or peer.label_uploaded_at is not null
       or peer.label_purchased_at is not null
       or peer.label_url is not null then
      raise exception 'label_exists' using errcode = 'P0001';
    end if;
  end loop;

  for i in 1 .. cardinality(v_ids) loop
    insert into public.bundle_splits (store_id, order_id) values (v_store, v_ids[i])
    on conflict do nothing;
    delete from public.bundle_links
    where store_id = v_store and (order_id = v_ids[i] or peer_id = v_ids[i]);
  end loop;

  insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
  select v_store, w.sku, 'edit', 'order_unbundled', array_to_string(v_ids, ','),
         public.disposition_actor_name(auth.uid()), auth.uid(),
         'Manual unbundle before label.'
  from public.web_orders w
  where w.store_id = v_store and w.id = v_ids[1];

  return jsonb_build_object('ok', true, 'count', cardinality(v_ids), 'ids', to_jsonb(v_ids));
end $$;

revoke all on function public.portal_unbundle_orders(uuid[]) from public, anon;
grant execute on function public.portal_unbundle_orders(uuid[]) to authenticated, service_role;

-- Copy a lead label / tracking onto every open peer in the same shipment.
create or replace function public.portal_mirror_shipment_label(p_lead uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  lead public.web_orders;
  peer public.web_orders;
  mirrored int := 0;
  skus jsonb := '[]'::jsonb;
begin
  select * into lead from public.web_orders where id = p_lead;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if v_store is null and current_setting('request.jwt.claim.role', true) = 'service_role' then
    v_store := lead.store_id;
  end if;
  if v_store is null or (v_store is distinct from lead.store_id) or (
    not public.is_staff()
    and current_setting('request.jwt.claim.role', true) is distinct from 'service_role'
  ) then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if lead.label_storage_path is null and lead.label_uploaded_at is null and lead.tracking_number is null then
    return jsonb_build_object('ok', true, 'mirrored', 0, 'skus', skus);
  end if;

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
          and public.bundle_addr(coalesce(w.ship_line2, '')) = public.bundle_addr(coalesce(lead.ship_line2, ''))
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
    update public.web_orders set
      label_storage_path = coalesce(lead.label_storage_path, peer.label_storage_path),
      label_file_name = coalesce(lead.label_file_name, peer.label_file_name),
      label_mime = coalesce(lead.label_mime, peer.label_mime),
      label_uploaded_at = coalesce(lead.label_uploaded_at, peer.label_uploaded_at),
      label_purchased_at = coalesce(lead.label_purchased_at, peer.label_purchased_at),
      label_origin = coalesce(lead.label_origin, peer.label_origin),
      label_url = coalesce(lead.label_url, peer.label_url),
      tracking_number = coalesce(lead.tracking_number, peer.tracking_number),
      marketplace_tracking_number = coalesce(peer.marketplace_tracking_number, lead.marketplace_tracking_number),
      carrier = coalesce(lead.carrier, peer.carrier),
      tracking_url = coalesce(lead.tracking_url, peer.tracking_url),
      tracking_needs_entry = lead.tracking_needs_entry,
      label_tracking_mismatch = lead.label_tracking_mismatch,
      tracking_exception = lead.tracking_exception,
      -- One label expense on the lead. Peers keep buyer shipping on their own sale row.
      label_cost_cents = case
        when peer.label_cost_cents is not null then peer.label_cost_cents
        else null
      end,
      updated_at = now()
    where id = peer.id;
    mirrored := mirrored + 1;
    skus := skus || jsonb_build_array(peer.sku);
  end loop;

  return jsonb_build_object('ok', true, 'mirrored', mirrored, 'skus', skus);
end $$;

revoke all on function public.portal_mirror_shipment_label(uuid) from public, anon;
grant execute on function public.portal_mirror_shipment_label(uuid) to authenticated, service_role;

commit;
