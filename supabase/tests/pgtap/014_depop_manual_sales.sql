-- pgTAP: manual Depop sales (20261030180000_depop_manual_sales.sql).
begin;
select plan(7);
do $$
declare v_store uuid; v_owner uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_owner, v_store, 'Owner', 'owner');
  perform public.seed_store_settings(v_store, 'Depop Store');
  insert into public.sku_ledger (sku, issued_at, store_id) values ('96001', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at)
  values ('96001', 'Bagsmart', 'Backpack', 2500, 800, 'available', v_store, now(), now());
  insert into public.marketplace_email_sales (store_id, message_id, marketplace, state, order_number, reason)
  values (v_store, 'msg-dp-1', 'depop', 'needs_review', 'DP-777', 'possible Depop sale, enter it');
  perform set_config('test.store', v_store::text, true);
end $$;

select set_config('request.jwt.claim.role', 'service_role', true);
select is((public.depop_record_manual_sale(current_setting('test.store')::uuid, '96001', 2000, 'DP-777',
  500, 345, 100, 450, now(), null) ->> 'duplicate'), 'false', 'manual Depop sale recorded');
select is((select state from public.units where sku = '96001' and store_id = current_setting('test.store')::uuid), 'sold', 'unit marked sold');
select is((select channel_fee_cents from public.sale_ledger where sku = '96001'), 445, 'fees = processing + boosting (manual, not estimated)');
select is((select profit_cents from public.sale_ledger where sku = '96001'), 2000 + 500 - 445 - 450 - 800, 'profit = sale + buyer ship - fees - label - cost');
select is((public.depop_record_manual_sale(current_setting('test.store')::uuid, '96001', 2000, 'DP-777') ->> 'duplicate'), 'true',
  'same Depop order is never recorded twice');
select is((select count(*)::int from public.sales where sku = '96001' and store_id = current_setting('test.store')::uuid), 1, 'one sale only');
select is((select state from public.marketplace_email_sales where message_id = 'msg-dp-1'), 'matched', 'flagged email linked to the sale');
select * from finish();
rollback;
