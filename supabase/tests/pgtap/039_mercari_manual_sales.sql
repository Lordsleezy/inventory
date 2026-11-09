-- pgTAP: Mercari manual sale entry, import guard, fee (10% of item+ship), listing cap.
begin;
select plan(27);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid(); v_jacob uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul), (v_jacob);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_paul, v_store, 'Paul', 'owner'), (v_jacob, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Mercari Store');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'commission_store_absorbs_fees', 'false'),
    (v_store, 'online_channels', '["website","ebay","depop","mercari"]'), (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text)),
    (v_store, 'channel_fee_rates', '{"mercari":{"pct":10,"fixed_cents":0}}'::jsonb)
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values (v_store, 'paul', v_paul), (v_store, 'jacob', v_jacob);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values (v_store, v_paul, 'percent_profit', 20), (v_store, v_jacob, 'percent_profit', 10);
  insert into public.sku_ledger (sku, issued_at, store_id) select s, now(), v_store from unnest(array['97001','97002','97003','97004']) s;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at) values
    ('97001', 'A', 'Costed', 6000, 1000, 'available', v_store, now(), now()),
    ('97002', 'A', 'No cost', 6000, null, 'available', v_store, now(), now()),
    ('97003', 'A', 'Listed elsewhere', 6000, 1000, 'available', v_store, now(), now()),
    ('97004', 'A', 'Cap filler', 6000, 1000, 'available', v_store, now(), now());
  insert into public.listings (store_id, sku, channel, status) values (v_store, '97003', 'ebay', 'listed'), (v_store, '97003', 'mercari', 'listed');
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
end $$;

select throws_ok($q$insert into public.sales (store_id, sku, price_cents, channel, sold_at, receipt_no, qty)
  values (current_setting('test.store')::uuid, '97001', 1000, 'mercari', now(), 'X-1', 1)$q$, 'P0001', null, 'importer cannot create a Mercari sale');

select is(public.mercari_default_fee_cents(5800, 1000), 680, 'fee is 10% of item + buyer shipping');
select is(public.channel_fee_estimate(current_setting('test.store')::uuid, 'mercari', 6800)->>'fee_cents', '680', 'estimate on item+ship base');

select set_config('request.jwt.claim.sub', current_setting('test.jacob'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok($q$select public.portal_mercari_record_sale('97001', 5000, 500, null, null, null, 0, 0)$q$, '42501', null, 'clerk cannot record a Mercari sale');

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select lives_ok($q$select public.portal_mercari_add_listing('97001','https://www.mercari.com/us/item/m1/',5000,null)$q$, 'admin adds live listing');
select is((select count(*)::int from public.portal_mercari_live_listings()), 2, 'live listings include seed + new');
select is((public.portal_mercari_live_count()->>'cap')::int, 200, 'cap is 200');

select lives_ok($q$select public.portal_mercari_record_sale('97001', 5000, null, null, current_date - 1, 'test', 1000, 400)$q$, 'admin records Mercari sale; shipping and label are not sale fields');
select is((select state from public.units where sku = '97001'), 'sold', 'unit is sold');
select is((select fee_cents from public.mercari_sale_entries where sku = '97001'), 500, 'fee defaults to 10% of the sale price');
select is((select payout_cents from public.mercari_sale_entries where sku = '97001'), 4500, 'payout defaults to sale minus fee');
select is((select shipping_cents from public.sales where sku = '97001'), 0, 'buyer shipping is not stored on a Mercari sale');
select is((select amount_cents from public.portal_expenses where external_id = 'mercari-label:' || (select id::text from public.sales where sku = '97001')), 400, 'a passed label is reimbursed, not kept on the sale');
select is((select status from public.listings where sku = '97001' and channel = 'mercari'), 'delisted', 'cleared from Mercari tracker');
select is((select count(*)::int from public.delist_tasks where sku = '97003' and channel = 'ebay' and completed_at is null), 0, 'sanity: unrelated SKU unchanged');

select lives_ok($q$select public.portal_mercari_record_sale('97003', 6000, 600, 5000, null, null, 0, 400)$q$, 'sale with other-channel listing');
select is((select status from public.listings where sku = '97003' and channel = 'mercari'), 'delisted', 'mercari delisted on sale');
select is((select count(*)::int from public.delist_tasks where sku = '97003' and channel = 'ebay' and completed_at is null), 1, 'delist task for eBay');
select ok((select o.status = 'paid' and o.fulfillment = 'ship' and o.shipped_at is null from public.web_orders o join public.sales s on s.id = o.sale_id where s.sku = '97003'),
  'manual entry goes to To Ship');

select lives_ok($q$select public.portal_mercari_record_sale('97002', 5000, 500, null, null, null, 0, 0)$q$, 'unit without cost accepted');
select ok((select c.amount_cents is null from public.sale_commissions c join public.sales s on s.id = c.sale_id where s.sku = '97002' and c.employee_id = current_setting('test.paul')::uuid),
  'no cost: commission waits');

select lives_ok(format($q$select public.portal_mercari_update_sale(%L::uuid, 6000, 600, 5400, (now() at time zone 'America/Los_Angeles')::date, null, 0, 0)$q$,
  (select id from public.mercari_sale_entries where sku = '97001')), 'entry can be edited');

select lives_ok(format($q$select public.portal_mercari_delete_sale(%L::uuid)$q$, (select id from public.mercari_sale_entries where sku = '97001')), 'entry can be deleted');
select is((select count(*)::int from public.sales where sku = '97001'), 0, 'deleted entry leaves no sale');
select is((select state from public.units where sku = '97001'), 'available', 'unit back in stock');

-- Cap: fill to 200 then reject
do $$
declare v_store uuid := current_setting('test.store')::uuid; i int; v_sku text;
begin
  perform set_config('floor.mercari_tracker_record', 'on', true);
  for i in 1..200 loop
    v_sku := '98' || lpad(i::text, 3, '0');
    insert into public.sku_ledger (sku, issued_at, store_id) values (v_sku, now(), v_store)
      on conflict do nothing;
    insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at)
      values (v_sku, 'A', 'Cap', 1000, 100, 'available', v_store, now(), now())
      on conflict do nothing;
    insert into public.listings (store_id, sku, channel, status, mercari_confirmed_at)
      values (v_store, v_sku, 'mercari', 'listed', now())
      on conflict (store_id, sku, channel) do update set status = 'listed', delisted_at = null, mercari_confirmed_at = now();
  end loop;
end $$;
select is(public.mercari_live_count(current_setting('test.store')::uuid), 200, 'filled to 200 live listings');
select throws_ok($q$select public.portal_mercari_add_listing('97004','https://www.mercari.com/us/item/m2/',1000,null)$q$,
  'P0001', null, 'blocks adding past 200');

select * from finish();
rollback;
