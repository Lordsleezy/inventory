-- Owner desk can open Books list and frozen payout commissions.
begin;
select plan(2);

do $$
declare
  v_store uuid;
  v_owner uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Steve', 'owner');
  perform public.seed_store_settings(v_store, 'owner books');
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.owner', v_owner::text, true);
end $$;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);

select lives_ok(
  $$select public.portal_books_list('2026-01-01'::date, (now() at time zone 'America/Los_Angeles')::date)$$,
  'owner can list books periods'
);

select lives_ok(
  $$select count(*) from public.portal_payout_commissions()$$,
  'owner can read frozen payout commissions'
);

select * from finish();
rollback;
