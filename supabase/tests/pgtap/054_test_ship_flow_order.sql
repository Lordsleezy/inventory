begin;
select plan(2);

do $$
declare
  v_store uuid;
  v_admin uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_admin);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_admin, v_store, 'Admin', 'manager');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.sku_ledger (store_id, sku, issued_at, label, fate)
    values (v_store, '90088', now(), 'test', 'sold');
  insert into public.units (store_id, sku, brand, title, ask_cents, state, qty_on_hand, received_at, updated_at)
    values (v_store, '90088', 'Test', 'TEST — ship flow (do not ship)', 1000, 'sold', 0, now(), now());
  insert into public.web_orders (
    store_id, sku, status, channel, fulfillment, order_no, paid_at,
    item_cents, total_cents, match_status, marketplace_title,
    label_storage_path, label_origin, tracking_number, carrier, packaged_at, shipped_at
  ) values (
    v_store, '90088', 'paid', 'mercari', 'ship', 'TEST-SHIP-FLOW', now(),
    1000, 1000, 'matched', 'TEST — ship flow (do not ship)',
    'labels/test.pdf', 'upload', '9400111899223344556601', 'USPS', now(), now()
  );
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.admin', v_admin::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.admin'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $q$select public.portal_reset_test_ship_flow_order()$q$,
  'admin can reset TEST-SHIP-FLOW back to to ship'
);

select ok(
  (select packaged_at is null and shipped_at is null from public.web_orders where order_no = 'TEST-SHIP-FLOW'),
  'reset clears packaged and shipped timestamps'
);

select * from finish();
rollback;
