-- pgTAP: replacements and giveaways (20261031100000_replacements_giveaways.sql).
begin;
select plan(52);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid(); v_jacob uuid := gen_random_uuid();
  v_store2 uuid; v_paul2 uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul), (v_jacob), (v_paul2);
  insert into public.stores default values returning id into v_store;
  insert into public.stores default values returning id into v_store2;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner'), (v_jacob, v_store, 'Jacob', 'staff'), (v_paul2, v_store2, 'Paul2', 'owner');
  perform public.seed_store_settings(v_store, 'Replacement Store');
  perform public.seed_store_settings(v_store2, 'Paid Store');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'online_channels', '["website"]'), (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text)),
    (v_store2, 'online_channels', '["website"]'), (v_store2, 'online_payout_pct', '30'),
    (v_store2, 'online_payout_employee_id', to_jsonb(v_paul2::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values
    (v_store, 'paul', v_paul), (v_store, 'jacob', v_jacob), (v_store2, 'paul', v_paul2);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values
    (v_store, v_paul, 'percent_profit', 20), (v_store, v_jacob, 'percent_profit', 10),
    (v_store2, v_paul2, 'percent_profit', 20);
  insert into public.sku_ledger (sku, issued_at, store_id)
    select x, now(), v_store from unnest(array['94001','94002','94003','94004','94005','94006','94007','94008']) x;
  insert into public.sku_ledger (sku, issued_at, store_id)
    select x, now(), v_store2 from unnest(array['95001','95002']) x;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at, qty_on_hand) values
    ('94001', 'A', 'Sold one', 10000, 4000, 'sold', v_store, now(), now(), 0),
    ('94002', 'A', 'Replacement unit', 10000, 1500, 'available', v_store, now(), now(), 1),
    ('94003', 'A', 'Replacement no cost', 5000, null, 'available', v_store, now(), now(), 1),
    ('94004', 'A', 'Giveaway', 5000, 3000, 'available', v_store, now(), now(), 1),
    ('94005', 'A', 'Giveaway no cost', 5000, null, 'available', v_store, now(), now(), 1),
    ('94006', 'A', 'Clerk target', 5000, 100, 'available', v_store, now(), now(), 1),
    ('94007', 'A', 'Sold two', 5000, 1000, 'sold', v_store, now(), now(), 0),
    ('94008', 'A', 'Spare', 5000, 100, 'available', v_store, now(), now(), 1),
    ('95001', 'A', 'Paid sold', 10000, 4000, 'sold', v_store2, now(), now(), 0),
    ('95002', 'A', 'Paid replacement', 10000, 1000, 'available', v_store2, now(), now(), 1);
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty, ticket_id,
    shipping_cents, processing_fee_cents, processing_fee_source) values
    (v_store, '94001', 10000, 0, 'floor', 'cash', now(), 'RG-1', v_paul, 1, null, 0, 0, 'actual'),
    (v_store, '94007', 5000, 0, 'floor', 'cash', now(), 'RG-2', v_paul, 1, null, 0, 0, 'actual'),
    (v_store2, '95001', 10000, 0, 'floor', 'cash', now(), 'RG-3', v_paul2, 1, null, 0, 0, 'actual');
  insert into public.listings (store_id, sku, channel, status) values (v_store, '94004', 'ebay', 'listed');
  insert into public.portal_payout_payments (store_id, employee_id, amount_cents, paid_by)
    values (v_store2, v_paul2, 1200, v_paul2);
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
  perform set_config('test.store2', v_store2::text, true);
  perform set_config('test.paul2', v_paul2::text, true);
  perform set_config('test.sale1', (select id::text from public.sales where receipt_no = 'RG-1'), true);
  perform set_config('test.sale2', (select id::text from public.sales where receipt_no = 'RG-2'), true);
  perform set_config('test.sale3', (select id::text from public.sales where receipt_no = 'RG-3'), true);
end $$;

create temp view c as
  select s.receipt_no, case when sc.employee_id = current_setting('test.jacob')::uuid then 'jacob' else 'paul' end who, sc.amount_cents
  from public.sale_commissions sc join public.sales s on s.id = sc.sale_id;

select is((select amount_cents from c where receipt_no = 'RG-1' and who = 'paul'), 1200, 'baseline: Paul 20% of (10000 − 4000)');

-- Clerk: nothing works ----------------------------------------------------
select set_config('request.jwt.claim.sub', current_setting('test.jacob'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok(format($q$select public.portal_record_replacement('94002', %s, true, 0, null)$q$, current_setting('test.sale1')),
  '42501', null, 'clerk cannot record a replacement');
select throws_ok($q$select public.portal_record_giveaway('94006', 'Sam', null)$q$, '42501', null, 'clerk cannot record a giveaway');
select throws_ok($q$select public.portal_undo_disposition(gen_random_uuid())$q$, '42501', null, 'clerk cannot undo');
select throws_ok($q$select public.portal_dispositions_list()$q$, '42501', null, 'clerk cannot list dispositions');
select throws_ok($q$select public.portal_replacement_sale_search('RG')$q$, '42501', null, 'clerk cannot search sales');
select is((select state from public.units where sku = '94002'), 'available', 'clerk attempt left stock untouched');

-- Admin: replacement lowers the original sale's profit and commission -------
select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select is(jsonb_array_length(public.portal_replacement_sale_search('RG-1')), 1, 'search finds the sale by sale #');
select is(jsonb_array_length(public.portal_replacement_sale_search('94001')), 1, 'search finds the sale by SKU');
select lives_ok(format($q$select public.portal_record_replacement('94002', %s, true, 500, 'bad on arrival')$q$, current_setting('test.sale1')),
  'admin records a replacement');
select is((select state from public.units where sku = '94002'), 'replaced', 'replacement unit left stock');
select is((select count(*)::int from public.sales where sku = '94002'), 0, 'not a sale: no sales row');
select is((select cost_cents from public.sale_ledger where receipt_no = 'RG-1'), 6000, 'ledger cost = 4000 + 1500 replacement + 500 extra');
select is((select profit_cents from public.sale_ledger where receipt_no = 'RG-1'), 4000, 'sale profit dropped from 6000 to 4000');
select is((select amount_cents from c where receipt_no = 'RG-1' and who = 'paul'), 800, 'Paul commission recalculated: 20% of 4000');
select is((select amount_cents from c where receipt_no = 'RG-1' and who = 'jacob'), 400, 'Jacob commission recalculated: 10% of 4000');
select is((select count(*)::int from public.units where condition = 'Defective' and listing_specs->>'bad_unit_of' = '94001'), 1,
  'bad unit came back: Defective unit linked to the replacement');
select is((select count(*)::int from public.portal_payout_adjustments), 0, 'unpaid sale: no adjustment, commission just drops');
select is((select count(*)::int from public.portal_expenses), 0, 'replacement posts no expense');

-- Undo reverses cleanly ----------------------------------------------------
select lives_ok(format($q$select public.portal_undo_disposition(%L::uuid)$q$,
  (select id from public.unit_dispositions where sku = '94002')), 'admin undoes the replacement');
select is((select state from public.units where sku = '94002'), 'available', 'undo: unit back in stock');
select is((select amount_cents from c where receipt_no = 'RG-1' and who = 'paul'), 1200, 'undo: Paul commission restored');
select is((select amount_cents from c where receipt_no = 'RG-1' and who = 'jacob'), 600, 'undo: Jacob commission restored');
select is((select cost_cents from public.sale_ledger where receipt_no = 'RG-1'), 4000, 'undo: ledger cost restored');

-- Replacement unit with no cost: payout waits -----------------------------
select lives_ok(format($q$select public.portal_record_replacement('94003', %s, false, 0, null)$q$, current_setting('test.sale2')),
  'replacement with no cost entered');
select ok((select amount_cents is null from c where receipt_no = 'RG-2' and who = 'paul'), 'no cost on replacement: payout waits');
select is((select bad_unit_status from public.unit_dispositions where sku = '94003' and undone_at is null), 'pending',
  'bad unit not back yet is recorded as pending');
select lives_ok(format($q$select public.portal_replacement_bad_unit_returned(%L::uuid)$q$,
  (select id from public.unit_dispositions where sku = '94003' and undone_at is null)), 'Bad unit came back action');
select is((select bad_unit_status from public.unit_dispositions where sku = '94003' and undone_at is null), 'returned', 'bad unit now returned');
update public.units set acquisition_cost_cents = 600 where sku = '94003';
select is((select amount_cents from c where receipt_no = 'RG-2' and who = 'paul'), 680, 'cost entered later: 20% of (5000 − 1000 − 600)');

-- Already paid: negative adjustment, history untouched -----------------------
select set_config('request.jwt.claim.sub', current_setting('test.paul2'), true);
select lives_ok(format($q$select public.portal_record_replacement('95002', %s, false, 0, null)$q$, current_setting('test.sale3')),
  'replacement against an already-paid sale');
select is((select sum(amount_cents)::int from public.portal_payout_adjustments where employee_id = current_setting('test.paul2')::uuid), -200,
  'paid sale: negative adjustment for the commission drop');
select is((select sum(amount_cents)::int from public.portal_payout_payments where employee_id = current_setting('test.paul2')::uuid), 1200,
  'payout history untouched');
select lives_ok(format($q$select public.portal_undo_disposition(%L::uuid)$q$,
  (select id from public.unit_dispositions where sku = '95002')), 'undo the paid-sale replacement');
select is((select sum(amount_cents)::int from public.portal_payout_adjustments where employee_id = current_setting('test.paul2')::uuid), 0,
  'undo: opposite adjustment, rows kept (no deletes)');
select is((select count(*)::int from public.portal_payout_adjustments where employee_id = current_setting('test.paul2')::uuid), 2,
  'both adjustment rows remain as history');

-- Giveaways ----------------------------------------------------------------
select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select is((select amount_cents from c where receipt_no = 'RG-1' and who = 'paul'), 1200, 'commission before giveaway');
select lives_ok($q$select public.portal_record_giveaway('94004', 'Sam', 'birthday')$q$, 'admin records a giveaway');
select is((select amount_cents from public.portal_expenses where category = 'Giveaways' and voided_at is null and description like '%94004%'), 3000,
  'giveaway cost posts to the Giveaways expense category');
select is((select status from public.listings where sku = '94004'), 'pending_delist', 'giveaway delists the unit');
select is((select amount_cents from c where receipt_no = 'RG-1' and who = 'paul'), 1200, 'giveaway does not touch commissions');
select lives_ok($q$select public.portal_record_giveaway('94005', 'Kim', null)$q$, 'giveaway with no cost is recorded anyway');
select ok((select (e->>'cost_missing')::boolean from jsonb_array_elements(public.portal_dispositions_list('giveaway')) e where e->>'sku' = '94005'),
  'giveaway without a cost shows cost missing');
select is((select amount_cents from public.portal_expenses where category='Giveaways' and description like '%94005%'), 0,
  'giveaway without cost records a zero-dollar expense');
select ok((select description like '%cost missing%' from public.portal_expenses where category='Giveaways' and description like '%94005%'),
  'zero-dollar giveaway expense says cost missing');
update public.units set acquisition_cost_cents = 700 where sku = '94005';
select is((select amount_cents from public.portal_expenses where category = 'Giveaways' and description like '%94005%'), 700,
  'cost entered later posts the expense');
select ok(exists(select 1 from jsonb_array_elements(public.portal_channel_report(current_date - 1, current_date + 2) -> 'expenses') e where e ->> 'category' = 'Giveaways'),
  'Reports expenses show Giveaways as its own category');
select lives_ok(format($q$select public.portal_undo_disposition(%L::uuid)$q$,
  (select id from public.unit_dispositions where sku = '94004')), 'undo giveaway');
select is((select count(*)::int from public.portal_expenses where description like '%94004%' and voided_at is null), 0, 'undo giveaway voids the expense');
select is((select state from public.units where sku = '94004'), 'available', 'undo giveaway: back in stock');

update public.units set state='repair' where sku='94008';
select lives_ok($q$select public.portal_record_giveaway('94008', 'Pat', null)$q$, 'admin can give away an unsold repair unit');
select is((select state from public.units where sku='94008'), 'given_away', 'repair unit leaves inventory through disposition');

select * from finish();
rollback;
