-- pgTAP: Money tab: adds / take-outs, payout payments, transfers, markers, admin-only.
begin;
select plan(11);
do $$
declare v_store uuid; v_owner uuid := gen_random_uuid(); v_clerk uuid := gen_random_uuid(); v_paul uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner), (v_clerk), (v_paul);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_owner, v_store, 'Owner', 'owner'), (v_clerk, v_store, 'Clerk', 'staff'), (v_paul, v_store, 'Paul', 'staff');
  perform public.seed_store_settings(v_store, 'Money Store');
  perform set_config('test.store', v_store::text, true); perform set_config('test.owner', v_owner::text, true);
  perform set_config('test.clerk', v_clerk::text, true); perform set_config('test.paul', v_paul::text, true);
end $$;
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;
create function pg_temp.bal(p text) returns bigint language sql as $$
  select (e->>'balance_cents')::bigint from jsonb_array_elements(public.portal_money_overview()) e where e->>'account' = p $$;

select is(pg_temp.bal('safe'), 0::bigint, 'a new store starts at zero');
insert into t_ids select 'add', public.portal_money_save(null, 'safe', 'in', 20000, 'starting_cash', 'float');
select is(pg_temp.bal('safe'), 20000::bigint, 'adding money raises the balance');
insert into t_ids select 'take', public.portal_money_save(null, 'safe', 'out', 2500, 'supplies', 'tape');
select is(pg_temp.bal('safe'), 17500::bigint, 'taking money out lowers it');

insert into t_ids select 'pay', public.portal_money_save(null, 'safe', 'out', 3000, 'person_payout', 'weekly', null, current_setting('test.paul')::uuid);
select is((select amount_cents from public.portal_payout_payments where withdrawal_id = (select id from t_ids where k = 'pay') and voided_at is null), 3000, 'a payout reason records a payment in Payouts');
select public.portal_money_save((select id from t_ids where k = 'pay'), 'safe', 'out', 3500, 'person_payout', 'weekly', null, current_setting('test.paul')::uuid);
select is((select amount_cents from public.portal_payout_payments where withdrawal_id = (select id from t_ids where k = 'pay') and voided_at is null), 3500, 'editing the entry updates the payment');
select public.portal_money_delete((select id from t_ids where k = 'pay'));
select ok((select voided_at is not null from public.portal_payout_payments where withdrawal_id = (select id from t_ids where k = 'pay')), 'deleting the entry voids the payment');

insert into t_ids select 'move', public.portal_money_save(null, 'safe', 'out', 1000, 'move_to_square', '');
select is(pg_temp.bal('safe') + pg_temp.bal('square'), 17500::bigint, 'a Safe -> Square move nets out across the two accounts');
select is(pg_temp.bal('square'), 1000::bigint, 'the matching entry landed on Square');
select public.portal_money_delete((select id from t_ids where k = 'move'));
select is(pg_temp.bal('square'), 0::bigint, 'deleting one side removes the other');

insert into public.withdrawal_balance_adjustments (store_id, source, actual_cents, adjusted_on, note) values (current_setting('test.store')::uuid, 'safe', 140, current_date, 'counted');
select is(pg_temp.bal('safe'), 17500::bigint, 'a counted marker never changes the balance');

select set_config('request.jwt.claim.sub', current_setting('test.clerk'), true);
select throws_ok($q$select public.portal_money_overview()$q$, '42501', null, 'clerks are blocked');
select * from finish();
rollback;
