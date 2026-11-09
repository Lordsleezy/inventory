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
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.admin', v_admin::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.admin'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $q$select public.portal_reset_test_ship_flow_order()$q$,
  'admin can create TEST-SHIP-FLOW when missing'
);

select ok(
  (select count(*)::int from public.web_orders where order_no = 'TEST-SHIP-FLOW' and packaged_at is null),
  1,
  'ensure leaves test order in to ship'
);

select * from finish();
rollback;
