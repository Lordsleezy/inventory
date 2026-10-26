-- pgTAP: Depop manual sale entry, import guard and removal (20261101100000_depop_manual_sales.sql).
begin;
select plan(33);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid(); v_jacob uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul), (v_jacob);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_paul, v_store, 'Paul', 'owner'), (v_jacob, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Depop Store');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'online_channels', '["website","ebay","depop"]'), (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values (v_store, 'paul', v_paul), (v_store, 'jacob', v_jacob);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values (v_store, v_paul, 'percent_profit', 20), (v_store, v_jacob, 'percent_profit', 10);
  insert into public.sku_ledger (sku, issued_at, store_id) select s, now(), v_store from unnest(array['96001','96002','96003','96004']) s;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at) values
    ('96001', 'A', 'Costed', 6000, 1000, 'available', v_store, now(), now()),
    ('96002', 'A', 'No cost', 6000, null, 'available', v_store, now(), now()),
    ('96003', 'A', 'Imported earlier', 6000, 1000, 'sold', v_store, now(), now()),
    ('96004', 'A', 'Listed elsewhere', 6000, 1000, 'available', v_store, now(), now());
  insert into public.listings (store_id, sku, channel, status) values (v_store, '96004', 'ebay', 'listed'), (v_store, '96004', 'depop', 'listed');
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
end $$;

-- Import guard: nothing creates Depop rows without the manual flag.
select throws_ok($q$insert into public.sales (store_id, sku, price_cents, channel, sold_at, receipt_no, qty)
  values (current_setting('test.store')::uuid, '96001', 1000, 'depop', now(), 'X-1', 1)$q$, 'P0001', null, 'importer cannot create a Depop sale');
select throws_ok($q$insert into public.web_orders (store_id, sku, status, channel, order_no, item_cents, shipping_cents, tax_cents, total_cents)
  values (current_setting('test.store')::uuid, 'UNMATCHED', 'paid', 'depop', 'DEPOP-X', 1000, 0, 0, 1000)$q$, 'P0001', null, 'importer cannot create a Depop order');
select throws_ok($q$insert into public.channel_orders (store_id, provider, order_id, sku, item_cents) values (current_setting('test.store')::uuid, 'depop', 'X', 'UNMATCHED', 1000)$q$,
  'P0001', null, 'importer cannot create Depop fees / channel orders');

-- Clerk
select set_config('request.jwt.claim.sub', current_setting('test.jacob'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok($q$select public.portal_depop_record_sale('96001', 5000, 500, null, null, null)$q$, '42501', null, 'clerk cannot record a Depop sale');
select throws_ok($q$select public.portal_depop_entries()$q$, '42501', null, 'clerk cannot list Depop entries');

-- Admin records a sale
select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select lives_ok($q$select public.portal_depop_record_sale('96001', 5000, 500, null, current_date - 1, 'test')$q$, 'admin records a Depop sale');
select is((select state from public.units where sku = '96001'), 'sold', 'unit is sold');
select is((select payout_cents from public.depop_sale_entries where sku = '96001'), 4500, 'payout defaults to sale - fee');
select is((select profit_cents from public.sale_ledger where sku = '96001'), 3500, 'profit = payout - cost');
select is((select amount_cents from public.sale_commissions c join public.sales s on s.id = c.sale_id where s.sku = '96001' and c.employee_id = current_setting('test.paul')::uuid),
  1050, 'online sale: 30% of profit to Paul');
select ok((select o.delivered_at is not null and o.status = 'paid' and o.channel = 'depop' from public.web_orders o join public.sales s on s.id = o.sale_id where s.sku = '96001'),
  'order goes straight to Done');
select is((select count(*)::int from public.sales where channel = 'depop' and sku = '96001' and voided_at is null), 1, 'counts as a normal sale');

-- Payout different from sale - fee (label taken out): profit follows the payout
select lives_ok($q$select public.portal_depop_record_sale('96004', 6000, 600, 5000, null, null)$q$, 'payout can differ from sale - fee');
select is((select profit_cents from public.sale_ledger where sku = '96004'), 4000, 'profit = payout 5000 - cost 1000');
select is((select status from public.listings where sku = '96004' and channel = 'depop'), 'delisted', 'delisted on Depop');
select is((select count(*)::int from public.delist_tasks where sku = '96004' and channel = 'ebay' and completed_at is null), 1, 'delist task for eBay');

-- No cost yet: payout waits
select lives_ok($q$select public.portal_depop_record_sale('96002', 5000, 500, null, null, null)$q$, 'unit without a cost is accepted');
select ok((select c.amount_cents is null from public.sale_commissions c join public.sales s on s.id = c.sale_id where s.sku = '96002' and c.employee_id = current_setting('test.paul')::uuid),
  'no cost: commission waits');
update public.units set acquisition_cost_cents = 1500 where sku = '96002';
select is((select c.amount_cents from public.sale_commissions c join public.sales s on s.id = c.sale_id where s.sku = '96002' and c.employee_id = current_setting('test.paul')::uuid),
  900, 'cost entered later: 30% of (4500 - 1500)');

-- Edit a typo
select lives_ok(format($q$select public.portal_depop_update_sale(%L::uuid, 6000, 600, 5400, (now() at time zone 'America/Los_Angeles')::date, null)$q$, (select id from public.depop_sale_entries where sku = '96001')), 'entry can be edited');
select is((select profit_cents from public.sale_ledger where sku = '96001'), 4400, 'profit follows the corrected payout');

-- Delete an entry
select lives_ok(format($q$select public.portal_depop_delete_sale(%L::uuid)$q$, (select id from public.depop_sale_entries where sku = '96001')), 'entry can be deleted');
select is((select count(*)::int from public.sales where sku = '96001'), 0, 'deleted entry leaves no sale');

-- One-time removal of an imported sale: unit stays sold, payments untouched
do $$ declare v_sale bigint; begin
  perform set_config('floor.depop_manual', 'on', true);
  insert into public.sales (store_id, sku, price_cents, channel, sold_at, receipt_no, qty, payment_id)
    values (current_setting('test.store')::uuid, '96003', 3000, 'depop', now(), 'IMP-1', 1, 'marketplace:depop:x') returning id into v_sale;
  insert into public.portal_payout_payments (store_id, employee_id, amount_cents, paid_by)
    values (current_setting('test.store')::uuid, current_setting('test.paul')::uuid, 500, current_setting('test.paul')::uuid);
  perform set_config('floor.depop_manual', 'off', true);
  perform set_config('test.imported', v_sale::text, true);
end $$;
select ok((select count(*) >= 1 from public.sale_commissions where sale_id = current_setting('test.imported')::bigint), 'imported sale had a commission');
select isnt(public.depop_purge_sale(current_setting('test.imported')::bigint, false), null, 'imported Depop sale is purged');
select ok((select state = 'sold' from public.units where sku = '96003') and not exists (select 1 from public.sales where sku = '96003')
  and not exists (select 1 from public.sale_commissions where sale_id = current_setting('test.imported')::bigint)
  and (select sum(amount_cents) from public.portal_payout_payments) = 500, 'unit stays sold, sale and commission gone, payment history untouched');

-- Sold units with no sale record can take a Depop sale; units with a sale cannot.
select is((select count(*)::int from jsonb_array_elements(public.portal_depop_find_units('96003')) e where (e->>'sold_no_sale')::boolean), 1, 'picker lists a sold unit with no sale');
select is((select count(*)::int from jsonb_array_elements(public.portal_depop_find_units('96002')) e), 0, 'picker hides a unit that already has a sale');
select lives_ok($q$select public.portal_depop_record_sale('96003', 4000, 400, null, null, null)$q$, 'sale attaches to the sold unit');
select is((select state from public.units where sku = '96003'), 'sold', 'unit stays sold');
select is((select count(*)::int from public.delist_tasks where sku = '96003'), 0, 'nothing delisted');
select is((select profit_cents from public.sale_ledger where sku = '96003'), 2600, 'profit = payout 3600 - cost 1000');
select throws_ok($q$select public.portal_depop_record_sale('96003', 4000, 400, null, null, null)$q$, 'P0001', null, 'a unit that now has a sale is blocked');
select * from finish();
rollback;
