-- Let admins create or reset TEST-SHIP-FLOW on the current store (phone ship-flow testing).

begin;

create or replace function public.portal_reset_test_ship_flow_order()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_sku constant text := '90001';
  v_sale bigint;
  v_created boolean := false;
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
    v_created := true;
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
      shippable = true,
      updated_at = now();

    insert into public.sales (
      store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at,
      receipt_no, qty
    ) values (
      v_store, v_sku, 1999, 0, 'website', 'card', now(), 'TEST-SHIP-1', 1
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
      v_store, v_sku, v_sale, 'paid', 'website', 'ship', 'TEST-SHIP-FLOW', now(),
      'Test Buyer', '123 Test St', 'Los Angeles', 'CA', '90001',
      1999, 0, 0, 1999,
      'matched', 'production',
      'TEST — ship flow (do not ship)', 200,
      format('%s/labels/test-ship-flow.pdf', v_store), 'upload', 'test-ship-flow.pdf', now(),
      '9400111899223344556601', 'USPS', 'Ground Advantage', 612
    )
    returning * into o;

    insert into public.events (store_id, sku, kind, field, new_value, actor, note)
    values (
      v_store, v_sku, 'edit', 'test_ship_flow_order',
      jsonb_build_object('order_id', o.id, 'order_no', 'TEST-SHIP-FLOW', 'tracking', '9400111899223344556601')::text,
      'portal_reset_test_ship_flow_order',
      'Test order for To ship → Packaged → Shipped on the phone'
    );
  else
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
    where id = o.id
    returning * into o;
  end if;

  return jsonb_build_object(
    'order_id', o.id,
    'order_no', o.order_no,
    'sku', o.sku,
    'tracking_number', o.tracking_number,
    'stage', 'to_ship',
    'created', v_created
  );
end $$;

commit;
