-- Bundle first, then upload one label.
-- Open (unshipped) lines can be linked even if someone already uploaded a
-- per-item label. Bundling clears those label/tracking fields so the shipment
-- goes back to Needs label for a single shared upload. Unbundle still blocks
-- while a label exists (void/clear first).

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
  v_cleared int := 0;
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
       or peer.shipped_at is not null
       or peer.packaged_at is not null then
      raise exception 'not_open' using errcode = 'P0001';
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

  -- Drop any per-item uploaded/bought labels so the box waits for ONE shared label.
  -- Does not call a carrier void — uploaded eBay PDFs are Floor copies only.
  update public.web_orders w
  set
    label_storage_path = null,
    label_file_name = null,
    label_mime = null,
    label_uploaded_at = null,
    label_url = null,
    label_transaction_id = null,
    label_purchased_at = null,
    label_origin = null,
    label_buying_at = null,
    tracking_number = null,
    tracking_url = null,
    carrier = null,
    service = null,
    shipping_rate = null,
    tracking_needs_entry = false,
    label_tracking_mismatch = false,
    tracking_exception = null,
    marketplace_tracking_number = coalesce(w.marketplace_tracking_number, null),
    updated_at = now()
  where w.store_id = v_store
    and w.id = any (v_ids)
    and (
      w.label_storage_path is not null
      or w.label_uploaded_at is not null
      or w.label_purchased_at is not null
      or w.label_url is not null
      or w.tracking_number is not null
    );
  get diagnostics v_cleared = row_count;

  insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
  select v_store, w.sku, 'edit', 'order_bundled', array_to_string(v_ids, ','),
         public.disposition_actor_name(auth.uid()), auth.uid(),
         format('Manual bundle of %s items%s.', cardinality(v_ids),
           case when v_cleared > 0 then format('; cleared %s prior label/tracking row(s) for one shared upload', v_cleared) else '' end)
  from public.web_orders w
  where w.store_id = v_store and w.id = v_ids[1];

  return jsonb_build_object(
    'ok', true,
    'count', cardinality(v_ids),
    'ids', to_jsonb(v_ids),
    'cleared_labels', v_cleared
  );
end $$;

revoke all on function public.portal_bundle_orders(uuid[]) from public, anon;
grant execute on function public.portal_bundle_orders(uuid[]) to authenticated, service_role;

commit;
