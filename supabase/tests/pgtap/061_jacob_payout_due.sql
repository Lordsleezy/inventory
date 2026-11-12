-- Jacob can read his own payout due. Anyone else cannot.
begin;
select plan(2);

select has_function('public', 'portal_my_payout_due', array[]::text[]);

select throws_ok(
  $$select public.portal_my_payout_due()$$,
  '42501',
  null,
  'anonymous cannot read a payout'
);

select finish();
rollback;
