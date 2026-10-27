-- pgTAP: payout import (no duplicates, adopts a matching manual entry, failed payouts not counted).
begin;
select plan(7);
do $$
declare v_store uuid; v_owner uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_owner, v_store, 'Owner', 'owner');
  perform public.seed_store_settings(v_store, 'Payout Store');
  insert into public.platform_withdrawals (store_id, platform, amount_cents, withdrawn_on, reason, note)
    values (v_store, 'ebay', 5000, '2026-10-20', 'other', 'typed by hand');
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.owner', v_owner::text, true);
end $$;
select is(public.floor_import_platform_payouts(current_setting('test.store')::uuid, 'ebay', '[
  {"external_id":"P1","amount_cents":5000,"on":"2026-10-21","status":"SUCCEEDED","note":"eBay payout P1"},
  {"external_id":"P2","amount_cents":12345,"on":"2026-10-22","status":"SUCCEEDED","note":"eBay payout P2"},
  {"external_id":"P3","amount_cents":900,"on":"2026-10-22","status":"FAILED","note":"eBay payout P3"}]'::jsonb),
  '{"inserted":2,"status_updated":0,"adopted_manual":1}'::jsonb, 'adopts the matching manual $50, inserts the other two');
select is((select count(*)::int from public.platform_withdrawals where store_id = current_setting('test.store')::uuid), 3, 'three rows, no duplicate of the manual entry');
select is(public.floor_import_platform_payouts(current_setting('test.store')::uuid, 'ebay', '[
  {"external_id":"P1","amount_cents":5000,"on":"2026-10-21","status":"SUCCEEDED"},
  {"external_id":"P2","amount_cents":12345,"on":"2026-10-22","status":"SUCCEEDED"}]'::jsonb),
  '{"inserted":0,"status_updated":0,"adopted_manual":0}'::jsonb, 'running it again adds nothing');
select is(public.floor_import_platform_payouts(current_setting('test.store')::uuid, 'ebay', '[{"external_id":"P3","amount_cents":900,"on":"2026-10-22","status":"SUCCEEDED"}]'::jsonb),
  '{"inserted":0,"status_updated":1,"adopted_manual":0}'::jsonb, 'a later status change is applied');
update public.platform_withdrawals set voided_at = now() where external_id = 'P2';
select is(public.floor_import_platform_payouts(current_setting('test.store')::uuid, 'ebay', '[{"external_id":"P2","amount_cents":12345,"on":"2026-10-22","status":"SUCCEEDED"}]'::jsonb),
  '{"inserted":0,"status_updated":0,"adopted_manual":0}'::jsonb, 'a payout the admin deleted is not re-added');
update public.platform_withdrawals set external_status = 'FAILED' where external_id = 'P3';
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is((select (e->>'withdrawn_cents')::int from jsonb_array_elements(public.portal_withdrawal_reconciliation()) e where e->>'source' = 'ebay'), 5000,
  'only the live $50 counts; deleted and failed payouts do not');
select is((select count(*)::int from jsonb_array_elements(public.portal_withdrawal_entries(50)) e where e->>'external_id' = 'P1'), 1, 'entries expose the payout id');
select * from finish();
rollback;
