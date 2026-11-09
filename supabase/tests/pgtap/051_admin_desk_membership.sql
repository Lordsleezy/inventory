-- Desk membership. The full admin grant is a portal_admins row.
-- staff.role = owner without that row is not portal_is_admin (20261228120000).
-- A manager still is. Staff, and an account with no role, are not.
-- An owner who also has portal_admins still receives sold prices.
begin;
select plan(6);

do $$
declare
  v_store uuid;
  v_admin uuid := gen_random_uuid();
  v_owner uuid := gen_random_uuid();
  v_mgr uuid := gen_random_uuid();
  v_clerk uuid := gen_random_uuid();
  v_unset uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values
    (v_admin, 'admin@example.test'),
    (v_owner, 'steve@steve.com'),
    (v_mgr, 'manager@example.test'),
    (v_clerk, 'clerk@example.test'),
    (v_unset, 'unset@example.test');
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_admin, v_store, 'Admin', 'owner'),
    (v_owner, v_store, 'Owner', 'owner'),
    (v_mgr, v_store, 'Manager', 'manager'),
    (v_clerk, v_store, 'Staff', 'staff');
  insert into public.portal_admins (user_id, store_id) values (v_admin, v_store);
  perform public.seed_store_settings(v_store, 'Admin desk');
  insert into public.sku_ledger (sku, issued_at, store_id) values ('99051', now(), v_store);
  insert into public.units (
    sku, brand, title, ask_cents, acquisition_cost_cents, state, qty_on_hand, store_id, received_at, updated_at
  ) values ('99051', 'Test', 'Admin sold', 2500, 900, 'sold', 0, v_store, now(), now());
  insert into public.sales (
    store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty
  ) values (v_store, '99051', 2500, 0, 'ebay', 'card', now(), 'R-ADM1', v_admin, 1);
  perform set_config('desk.admin', v_admin::text, true);
  perform set_config('desk.owner', v_owner::text, true);
  perform set_config('desk.mgr', v_mgr::text, true);
  perform set_config('desk.clerk', v_clerk::text, true);
  perform set_config('desk.unset', v_unset::text, true);
end;
$$;

select set_config('request.jwt.claim.role', 'authenticated', true);

select set_config('request.jwt.claim.sub', current_setting('desk.admin'), true);
select ok(
  public.portal_is_admin(),
  'owner with an explicit portal_admins row is an admin'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(public.receive_inventory_list('', 'sold', false, 'date', 0, 20, 'all')->'items') i
    where (i->>'sold_price_cents')::int = 2500
      and (i->>'acquisition_cost_cents')::int = 900
  ),
  'portal admin who is also staff owner still sees sold price and cost'
);

select set_config('request.jwt.claim.sub', current_setting('desk.owner'), true);
select ok(
  not public.portal_is_admin(),
  'owner staff role without portal_admins is not an admin'
);

select set_config('request.jwt.claim.sub', current_setting('desk.mgr'), true);
select ok(
  public.portal_is_admin(),
  'manager staff role is an admin without a portal_admins row'
);

select set_config('request.jwt.claim.sub', current_setting('desk.clerk'), true);
select ok(
  not public.portal_is_admin(),
  'staff role with no portal_admins row is not an admin'
);

select set_config('request.jwt.claim.sub', current_setting('desk.unset'), true);
select ok(
  not public.portal_is_admin(),
  'an account with no role and no portal_admins row is not an admin'
);

select finish();
rollback;
