-- pgTAP: clerks never see money on sold units (units_pos, sale_receipts) and
-- portal_store_id() is null for non-admins (20261030130000_clerk_money_lockdown.sql).
begin;
select plan(8);

do $$
declare
  v_store uuid;
  v_owner uuid := gen_random_uuid();
  v_clerk uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner), (v_clerk);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Owner', 'owner'),
    (v_clerk, v_store, 'Clerk', 'staff');
  perform public.seed_store_settings(v_store, 'Clerk Money Store');
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('91001', now(), v_store), ('91002', now(), v_store);
  insert into public.units (
    sku, brand, title, ask_cents, msrp_cents, acquisition_cost_cents, state, store_id, received_at, updated_at
  ) values
    ('91001', 'A', 'Available A', 1500, 3000, 100, 'available', v_store, now(), now()),
    ('91002', 'B', 'Sold B', 2000, 4000, 200, 'sold', v_store, now(), now());
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty)
  values (v_store, '91002', 2000, 150, 'floor', 'cash', now(), 'R-CM001', v_clerk, 1);
  perform set_config('test.owner_id', v_owner::text, true);
  perform set_config('test.clerk_id', v_clerk::text, true);
end;
$$;

-- Clerk
select set_config('request.jwt.claim.sub', current_setting('test.clerk_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select ask_cents from public.units_pos where sku = '91001'), 1500, 'clerk sees ask on available unit');
select is((select ask_cents from public.units_pos where sku = '91002'), null::int, 'clerk gets no ask on sold unit');
select is((select msrp_cents from public.units_pos where sku = '91002'), null::int, 'clerk gets no msrp on sold unit');
select is((select count(*)::int from public.sale_receipts), 0, 'clerk sees no sale receipts');
select is(public.portal_store_id(), null::uuid, 'portal_store_id is null for clerk');

-- Owner
select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select is((select ask_cents from public.units_pos where sku = '91002'), 2000, 'owner sees ask on sold unit');
select is((select count(*)::int from public.sale_receipts), 1, 'owner sees sale receipts');
select isnt(public.portal_store_id(), null::uuid, 'portal_store_id set for owner');

select * from finish();
rollback;
