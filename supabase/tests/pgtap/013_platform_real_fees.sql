-- pgTAP: platform-real fees (20261030170000_platform_real_fees.sql).
begin;
select plan(6);
do $$
declare v_store uuid; v_owner uuid := gen_random_uuid(); v_sale bigint;
begin
  insert into auth.users (id) values (v_owner);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_owner, v_store, 'Owner', 'owner');
  perform public.seed_store_settings(v_store, 'Fee Store');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'channel_fee_rates', '{"ebay":{"pct":13.25,"fixed_cents":30}}')
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.sku_ledger (sku, issued_at, store_id) values ('95001', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at)
  values ('95001', 'A', 'Promoted', 10000, 4000, 'sold', v_store, now(), now());
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, payment_id, sold_at, receipt_no, qty)
  values (v_store, '95001', 10000, 0, 'ebay', 'marketplace', 'ebay:12-34567-89012', now(), 'FEE-1', 1) returning id into v_sale;
  insert into public.channel_orders (store_id, provider, order_id, sku, sale_id, item_cents)
  values (v_store, 'ebay', '12-34567-89012', '95001', v_sale, 10000);
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.sale', v_sale::text, true);
end $$;

select is((select channel_fee_cents from public.sale_ledger where id = current_setting('test.sale')::bigint), 0,
  'no platform fee yet: no estimate (rate table ignored)');
select is((select fee_source from public.sale_ledger where id = current_setting('test.sale')::bigint), 'pending', 'fee is pending');
select ok((select fees_pending from public.sale_ledger where id = current_setting('test.sale')::bigint), 'fees_pending flag set');

select set_config('request.jwt.claim.role', 'service_role', true);
select public.channel_order_record_fees(current_setting('test.store')::uuid, 'ebay', '12-34567-89012',
  '[{"transaction_id":"T1","fee_type":"FINAL_VALUE_FEE","amount_cents":1325},
    {"transaction_id":"T1","fee_type":"FINAL_VALUE_FEE_FIXED_PER_ORDER","amount_cents":30},
    {"transaction_id":"N9","fee_type":"AD_FEE","amount_cents":800}]'::jsonb, 7845);
select is((select channel_fee_cents from public.sale_ledger where id = current_setting('test.sale')::bigint), 2155,
  'fees = selling + per-order + promoted listing (AD_FEE)');
select is((select profit_cents from public.sale_ledger where id = current_setting('test.sale')::bigint), 10000 - 2155 - 4000,
  'profit uses the platform fees');
select public.channel_order_record_fees(current_setting('test.store')::uuid, 'ebay', '12-34567-89012',
  '[{"transaction_id":"N9","fee_type":"AD_FEE","amount_cents":800}]'::jsonb);
select is((select channel_fee_cents from public.sale_ledger where id = current_setting('test.sale')::bigint), 2155,
  're-sync of the same transaction does not double count');
select * from finish();
rollback;
