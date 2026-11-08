begin;
select plan(6);

select has_function('public', 'floor_normalize_tracking', array['text']);
select is(public.floor_normalize_tracking('4209588893930123456789012345'), '9301234567890123456789012345',
  'USPS 420+ZIP wrapper strips to trailing tracking');

select has_function('public', 'portal_scan_out_commit', array['text', 'text']);

select lives_ok($$
  insert into public.stores (id, name, slug) values ('a0000000-0000-4000-8000-000000000099', 'scan test', 'scan-test')
  on conflict do nothing;
$$, 'store seed');

select throws_ok(
  $$select public.portal_scan_out_commit('9Z999AA10123456784')$$,
  '42501',
  null,
  'anonymous cannot scan out'
);

select finish();
rollback;
