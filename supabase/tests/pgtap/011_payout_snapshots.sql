-- pgTAP: payout snapshots (20261030150000_payout_snapshots.sql).
begin;
select plan(13);
set constraints all immediate;

do $$
declare v_store uuid; v_paul uuid := gen_random_uuid(); v_jacob uuid := gen_random_uuid(); v_ticket uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul), (v_jacob);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner'), (v_jacob, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Payout Store');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'online_channels', '["website"]'), (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text)), (v_store, 'cost_defaults', '{}')
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values (v_store, 'paul', v_paul), (v_store, 'jacob', v_jacob);
  insert into public.store_payout_sku_rates (store_id, sku, employee_id, rate) values
    (v_store, '93003', v_jacob, 25), (v_store, '93003', v_paul, 5);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values
    (v_store, v_paul, 'percent_profit', 20), (v_store, v_jacob, 'percent_profit', 10);
  insert into public.sku_ledger (sku, issued_at, store_id)
    select x, now(), v_store from unnest(array['93001','93002','93003','93004','93005','93006']) x;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at) values
    ('93001', 'A', 'In store', 10000, 4000, 'sold', v_store, now(), now()),
    ('93002', 'A', 'No cost', 5000, null, 'sold', v_store, now(), now()),
    ('93003', 'A', 'SKU rate', 10000, 2000, 'sold', v_store, now(), now()),
    ('93004', 'A', 'Website', 10000, 2000, 'sold', v_store, now(), now()),
    ('93005', 'A', 'Multi 1', 3000, 1000, 'sold', v_store, now(), now()),
    ('93006', 'A', 'Multi 2', 2000, 0, 'sold', v_store, now(), now());
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty, ticket_id) values
    (v_store, '93001', 10000, 0, 'floor', 'cash', now(), 'PAY-1', v_paul, 1, null),
    (v_store, '93002', 5000, 0, 'floor', 'cash', now(), 'PAY-2', v_paul, 1, null),
    (v_store, '93003', 10000, 0, 'floor', 'cash', now(), 'PAY-3', v_paul, 1, null),
    (v_store, '93004', 10000, 0, 'website', 'card', now(), 'PAY-4', null, 1, null),
    (v_store, '93005', 3000, 0, 'floor', 'cash', now(), 'PAY-5', v_paul, 1, v_ticket),
    (v_store, '93006', 2000, 0, 'floor', 'cash', now(), 'PAY-6', v_paul, 1, v_ticket);
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
  perform set_config('test.ticket', v_ticket::text, true);
end $$;

create temp view c as
  select s.sku, case when sc.employee_id = current_setting('test.paul')::uuid then 'paul' else 'jacob' end who, sc.amount_cents
  from public.sale_commissions sc join public.sales s on s.id = sc.sale_id
  where sc.store_id = current_setting('test.store')::uuid;

select is((select amount_cents from c where sku = '93001' and who = 'paul'), 1200, 'in-store: Paul 20% of sale − cost');
select is((select amount_cents from c where sku = '93001' and who = 'jacob'), 600, 'in-store: Jacob 10% of sale − cost');
select is((select amount_cents from c where sku = '93004' and who = 'paul'), 2400, 'online: Paul 30% of sale − cost');
select is((select amount_cents from c where sku = '93004' and who = 'jacob'), 0, 'online: Jacob nothing');
select is((select amount_cents from c where sku = '93003' and who = 'jacob'), 2000, 'per-SKU rate from store_payout_sku_rates');
select is((select amount_cents from c where sku = '93002' and who = 'paul'), 820,
  'no unit cost: provisional on the ledger''s default estimate (900), like the screen today');
select is((select sum(amount_cents)::int from c where sku in ('93005','93006') and who = 'paul'), 800,
  'multi-line ticket: lines sum to the ticket amount');

update public.units set acquisition_cost_cents = 9000 where store_id = current_setting('test.store')::uuid and sku = '93001';
select is((select amount_cents from c where sku = '93001' and who = 'paul'), 1200, 'editing cost later does not change a frozen payout');

update public.units set acquisition_cost_cents = 1000 where store_id = current_setting('test.store')::uuid and sku = '93002';
select is((select amount_cents from c where sku = '93002' and who = 'paul'), 800, 'real cost entered later replaces the estimate once');

update public.portal_payout_rules set rate = 50 where store_id = current_setting('test.store')::uuid;
select is((select amount_cents from c where sku = '93001' and who = 'jacob'), 600, 'rule change does not rewrite past sales');

insert into public.portal_commission_overrides (store_id, ticket_key, paul_pct, jacob_pct, updated_by)
select s.store_id, 'sale:' || s.id, 50, 0, current_setting('test.paul')::uuid
from public.sales s where s.store_id = current_setting('test.store')::uuid and s.sku = '93001';
select is((select amount_cents from c where sku = '93001' and who = 'paul'), 3000,
  'per-sale override recomputes on the frozen cost (base 6000, not today''s cost)');
select is((select amount_cents from c where sku = '93001' and who = 'jacob'), 0, 'override sets Jacob to 0');

select is((select commission_cents::int from public.payout_commission_totals(current_setting('test.store')::uuid)
  where employee_id = current_setting('test.paul')::uuid), 3000 + 800 + 400 + 2400 + 800,
  'payout_commission_totals sums frozen amounts');

select * from finish();
rollback;
