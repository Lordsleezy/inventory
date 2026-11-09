-- Owner desk: clerk floor reads, financial store scope, owner home sales.
begin;
select plan(8);

do $$
declare
  v_store uuid;
  v_owner uuid := gen_random_uuid();
  v_staff uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner), (v_staff);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Steve', 'owner'),
    (v_staff, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Steve owner');
  insert into public.sku_ledger (sku, issued_at, store_id) values ('99001', now(), v_store);
  insert into public.units (
    sku, brand, title, ask_cents, acquisition_cost_cents, state, qty_on_hand, store_id, received_at, updated_at
  ) values ('99001', 'Test', 'Owner item', 2500, 900, 'sold', 0, v_store, now(), now());
  insert into public.sales (
    store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty
  ) values (v_store, '99001', 2500, 0, 'ebay', 'card', now(), 'R-OWN1', v_owner, 1);
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.owner', v_owner::text, true);
  perform set_config('test.staff', v_staff::text, true);
end $$;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);

select ok(not public.portal_is_admin(), 'owner staff is not portal admin');
select ok(public.portal_financial_access(), 'owner staff has financial access');

select ok(
  not exists (
    select 1
    from jsonb_array_elements(public.receive_inventory_list('99001', 'sold', false, 'date', 0, 20, 'all')->'items') i
    where i ? 'sold_price_cents' or i ? 'ask_cents' or i ? 'acquisition_cost_cents'
  ),
  'owner sold list hides money like clerk'
);

select is(
  (select (public.portal_owner_home()->>'sales_today_count'))::int,
  1,
  'owner home sees today sale count'
);

select is(
  (select jsonb_array_length(public.portal_owner_home()->'recent_sales'))::int,
  1,
  'owner home lists today sales with prices'
);

select set_config('request.jwt.claim.sub', current_setting('test.staff'), true);
select ok(not public.portal_financial_access(), 'clerk has no financial access');

select throws_ok(
  $$select public.portal_owner_home()$$,
  '42501',
  'portal_access_denied',
  'clerk cannot call owner home'
);

select finish();
rollback;
