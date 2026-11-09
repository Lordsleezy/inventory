begin;
select plan(2);

select pgtap_seed_store();
select pgtap_login_owner();

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
