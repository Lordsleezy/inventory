-- A filed return can be recorded after the period exists. Nothing is sent to CDTFA.
begin;
select plan(2);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner');
  perform public.seed_store_settings(v_store, 'CDTFA filed');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $$ select public.portal_mark_cdtfa_filed('2026-09-01', '2026-09-30', '2026-11-08', 'check', 'ABC-1') $$,
  'marking a return filed does not require the Books month to be unlocked'
);

select is(
  (select public.portal_cdtfa_filings()->0->>'confirmation'),
  'ABC-1',
  'the filed return shows up for this store'
);

select * from finish();
rollback;
