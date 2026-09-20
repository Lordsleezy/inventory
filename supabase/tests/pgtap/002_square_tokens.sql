-- pgTAP: Square token table must be unreadable by staff and managers.
begin;
select plan(8);

select has_table('public', 'square_connections', 'square_connections exists');
select has_table('public', 'pos_devices', 'pos_devices exists');
select has_table('public', 'card_charges', 'card_charges exists');

select ok(
  not has_table_privilege('authenticated', 'public.square_connections', 'select'),
  'authenticated has no SELECT privilege on square_connections'
);

select ok(
  not has_table_privilege('anon', 'public.square_connections', 'select'),
  'anon has no SELECT privilege on square_connections'
);

select ok(
  has_table_privilege('service_role', 'public.square_connections', 'select'),
  'service_role can SELECT square_connections'
);

-- Seed store + ciphertext as superuser (FORCE RLS still bypassed by superuser).
do $$
declare
  v_store uuid;
  v_staff uuid := gen_random_uuid();
  v_mgr uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_staff), (v_mgr);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role)
  values
    (v_staff, v_store, 'Staff Test', 'staff'),
    (v_mgr, v_store, 'Manager Test', 'manager');
  insert into public.square_connections (
    store_id, merchant_id, location_id, access_token_enc, refresh_token_enc, expires_at, sandbox
  ) values (
    v_store, 'm_test', 'l_test', 'SECRET_ACCESS', 'SECRET_REFRESH', now() + interval '7 days', true
  );
  perform set_config('test.store_id', v_store::text, true);
  perform set_config('test.staff_id', v_staff::text, true);
  perform set_config('test.mgr_id', v_mgr::text, true);
end;
$$;

-- Staff: become authenticated with their JWT sub; SELECT must raise 42501.
select set_config('request.jwt.claim.sub', current_setting('test.staff_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select throws_ok(
  'select access_token_enc from public.square_connections',
  '42501',
  null,
  'staff cannot SELECT square_connections tokens'
);
reset role;

-- Manager: same denial for refresh token column.
select set_config('request.jwt.claim.sub', current_setting('test.mgr_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select throws_ok(
  'select refresh_token_enc from public.square_connections',
  '42501',
  null,
  'manager cannot SELECT square_connections tokens'
);
reset role;

select * from finish();
rollback;
