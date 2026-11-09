-- Floor production: one fake paid order in "To ship" with a USPS test tracking number.
-- Used to exercise Packaged → Shipped on the phone (SKU 90001, order TEST-SHIP-FLOW).
-- Scan-out barcode: 9400111899223344556601

begin;

create or replace function public.portal_reset_test_ship_flow_order()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  o public.web_orders;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into o
    from public.web_orders
   where store_id = v_store and order_no = 'TEST-SHIP-FLOW'
   for update;
  if not found then
    raise exception 'test_order_missing' using errcode = 'P0002';
  end if;
  update public.web_orders set
    packaged_at = null,
    packaged_by = null,
    packaged_by_name = null,
    shipped_at = null,
    shipped_by = null,
    shipped_by_name = null,
    delivered_at = null,
    delivered_by = null,
    delivered_by_name = null,
    boxed_at = null,
    pack_proof_photo_path = null,
    pack_proof_serial = null,
    pack_proof_at = null,
    updated_at = now()
  where id = o.id;
  return jsonb_build_object(
    'order_id', o.id,
    'order_no', o.order_no,
    'sku', o.sku,
    'tracking_number', o.tracking_number,
    'stage', 'to_ship'
  );
end $$;

revoke all on function public.portal_reset_test_ship_flow_order() from public, anon;
grant execute on function public.portal_reset_test_ship_flow_order() to authenticated, service_role;

do $$
declare
  v_store constant uuid := '5487ca47-6147-4fe8-bc6d-46b6472726ba';
  v_sku constant text := '90001';
  v_sale bigint;
  v_order uuid;
begin
  if not exists (select 1 from public.stores where id = v_store) then
    raise notice 'test_ship_flow: store missing, skip';
    return;
  end if;
  if exists (
    select 1 from public.web_orders where store_id = v_store and order_no = 'TEST-SHIP-FLOW'
  ) then
    raise notice 'test_ship_flow: order already present';
    return;
  end if;

  if not exists (select 1 from public.sku_ledger where sku = v_sku) then
    insert into public.sku_ledger (store_id, sku, issued_at, label, fate)
    values (v_store, v_sku, now(), 'TEST ship flow', 'sold');
  end if;

  insert into public.units (
    store_id, sku, brand, title, ask_cents, acquisition_cost_cents, state, qty_on_hand,
    shippable, received_at, updated_at
  ) values (
    v_store, v_sku, 'Test', 'TEST — ship flow (do not ship)', 1999, 500, 'sold', 0,
    true, now(), now()
  )
  on conflict (sku) do update set
    store_id = excluded.store_id,
    state = 'sold',
    qty_on_hand = 0,
    title = excluded.title,
    brand = excluded.brand,
    updated_at = now();

  insert into public.sales (
    store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at,
    receipt_no, qty
  ) values (
    v_store, v_sku, 1999, 0, 'mercari', 'card', now(), 'TEST-SHIP-1', 1
  )
  returning id into v_sale;

  insert into public.web_orders (
    store_id, sku, sale_id, status, channel, fulfillment, order_no, paid_at,
    buyer_name, ship_line1, ship_city, ship_region, ship_postal,
    item_cents, shipping_cents, tax_cents, total_cents,
    match_status, payment_env, marketplace_title, marketplace_fee_cents,
    label_storage_path, label_origin, label_file_name, label_uploaded_at,
    tracking_number, carrier, service, label_cost_cents
  ) values (
    v_store, v_sku, v_sale, 'paid', 'mercari', 'ship', 'TEST-SHIP-FLOW', now(),
    'Test Buyer', '123 Test St', 'Los Angeles', 'CA', '90001',
    1999, 0, 0, 1999,
    'matched', 'production',
    'TEST — ship flow (do not ship)', 200,
    format('%s/labels/test-ship-flow.pdf', v_store), 'upload', 'test-ship-flow.pdf', now(),
    '9400111899223344556601', 'USPS', 'Ground Advantage', 612
  )
  returning id into v_order;

  insert into public.events (store_id, sku, kind, field, new_value, actor, note)
  values (
    v_store, v_sku, 'edit', 'test_ship_flow_order',
  jsonb_build_object('order_id', v_order, 'order_no', 'TEST-SHIP-FLOW', 'tracking', '9400111899223344556601')::text,
    'migration:test_ship_flow',
    'Test order for To ship → Packaged → Shipped on the phone'
  );
end $$;

commit;
