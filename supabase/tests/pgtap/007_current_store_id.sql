-- pgTAP: current_store_id() final definition keeps both rules:
--   1. deactivated staff resolve to no store (admin_app_nav)
--   2. the floor.store_id GUC is honored for service_role only (web_checkout)
begin;
select plan(9);

do $$
declare
  v_store uuid;
  v_other uuid;
  v_active uuid := gen_random_uuid();
  v_gone uuid := gen_random_uuid();
  v_stranger uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_active), (v_gone), (v_stranger);
  insert into public.stores default values returning id into v_store;
  insert into public.stores default values returning id into v_other;
  insert into public.staff (user_id, store_id, display_name, role, deactivated_at) values
    (v_active, v_store, 'Active', 'staff', null),
    (v_gone, v_store, 'Gone', 'staff', now());
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.other', v_other::text, true);
  perform set_config('test.active', v_active::text, true);
  perform set_config('test.gone', v_gone::text, true);
  perform set_config('test.stranger', v_stranger::text, true);
end;
$$;

-- Authenticated, active staff: own store; the GUC cannot redirect them.
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', current_setting('test.active'), true);
select set_config('floor.store_id', '', true);
select is(public.current_store_id()::text, current_setting('test.store'),
  'active staff resolves to own store');
select set_config('floor.store_id', current_setting('test.other'), true);
select is(public.current_store_id()::text, current_setting('test.store'),
  'active staff ignores floor.store_id GUC');

-- Deactivated staff: no store, with or without the GUC.
select set_config('request.jwt.claim.sub', current_setting('test.gone'), true);
select set_config('floor.store_id', '', true);
select is(public.current_store_id(), null::uuid, 'deactivated staff resolves to no store');
select set_config('floor.store_id', current_setting('test.store'), true);
select is(public.current_store_id(), null::uuid,
  'deactivated staff cannot regain a store via floor.store_id');

-- Authenticated non-staff and anon: GUC ignored.
select set_config('request.jwt.claim.sub', current_setting('test.stranger'), true);
select is(public.current_store_id(), null::uuid, 'authenticated non-staff ignores floor.store_id');
select set_config('request.jwt.claim.role', 'anon', true);
select set_config('request.jwt.claim.sub', '', true);
select is(public.current_store_id(), null::uuid, 'anon ignores floor.store_id');

-- service_role: honors the GUC, nothing without it.
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('floor.store_id', current_setting('test.other'), true);
select is(public.current_store_id()::text, current_setting('test.other'),
  'service_role honors floor.store_id');
select set_config('floor.store_id', '', true);
select is(public.current_store_id(), null::uuid, 'service_role without GUC has no store');

-- service_role acting on behalf of a deactivated user still gets no staff store.
select set_config('request.jwt.claim.sub', current_setting('test.gone'), true);
select is(public.current_store_id(), null::uuid,
  'service_role does not resolve a deactivated staff row');

select * from finish();
rollback;
