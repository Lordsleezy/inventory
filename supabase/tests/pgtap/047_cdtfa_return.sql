-- CDTFA-401-A worksheet: voids stay out, marketplace sales are deducted once,
-- out-of-state shipments are interstate, a missing ship-to state is not ready.
begin;
select plan(8);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner');
  perform public.seed_store_settings(v_store, 'CDTFA test');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.sku_ledger (sku, issued_at, store_id)
  select s, now(), v_store from unnest(array['94701','94702','94703','94704','94705']) s;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at)
  select s, 'Test', s, 1000, 100, 'available', v_store, now(), now()
  from unnest(array['94701','94702','94703','94704','94705']) s;
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, payment_id, receipt_no, qty, sold_at)
  values
    (v_store, '94701', 10000, 725, 'floor', 'cash', 'cdtfa-94701', 'C1', 1, now()),
    (v_store, '94702', 5000, 0, 'ebay', 'ebay', 'cdtfa-94702', 'C2', 1, now()),
    (v_store, '94703', 4000, 0, 'website', 'card', 'cdtfa-94703', 'C3', 1, now()),
    (v_store, '94704', 3000, 0, 'website', 'card', 'cdtfa-94704', 'C4', 1, now()),
    (v_store, '94705', 2000, 145, 'floor', 'cash', 'cdtfa-94705', 'C5', 1, now());
  update public.sales set voided_at = now(), void_reason = 'void, not a return'
   where sku = '94705' and store_id = v_store;
  insert into public.web_orders (store_id, sku, sale_id, channel, order_no, status, fulfillment, item_cents, shipping_cents, tax_cents, total_cents, ship_region, ship_city, payment_env)
  select v_store, s.sku, s.id, 'website', 'W-' || s.sku, 'paid', 'ship', s.price_cents, 0, 0, s.price_cents,
    case s.sku when '94703' then 'NV' else null end,
    case s.sku when '94703' then 'Reno' else null end,
    'production'
  from public.sales s where s.store_id = v_store and s.sku in ('94703', '94704');
  insert into public.returns (store_id, sku, sale_id, channel, reason, status, refund_cents)
  values (v_store, '94701', (select id from public.sales where sku = '94701'), 'floor', 'other', 'refunded_no_return', 1000);
  insert into public.return_refunds (store_id, return_id, amount_cents, refunded_on, channel, kind, item_kept)
  values (v_store, (select id from public.returns where sku = '94701'), 1000,
    (timezone('America/Los_Angeles', now()))::date, 'floor', 'partial', true);
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

create temporary table cdtfa as
select public.portal_cdtfa_return(
  date_trunc('month', (timezone('America/Los_Angeles', now()))::date)::date,
  (date_trunc('month', (timezone('America/Los_Angeles', now()))::date) + interval '1 month - 1 day')::date
) as doc;

select is((select (x->>'dollars')::int from cdtfa, jsonb_array_elements(doc->'lines') x where x->>'id' = '1'), 220, 'voided sale is not in total sales');
select is((select (x->>'dollars')::int from cdtfa, jsonb_array_elements(doc->'lines') x where x->>'id' = '10'), 50, 'marketplace sale is an other deduction');
select is((select (x->>'dollars')::int from cdtfa, jsonb_array_elements(doc->'lines') x where x->>'id' = '8'), 40, 'out-of-state shipment is interstate');
select is((select (x->>'dollars')::int from cdtfa, jsonb_array_elements(doc->'lines') x where x->>'id' = 'B3'), 10, 'logged refund is returned taxable merchandise');
select is((select (x->>'dollars')::int from cdtfa, jsonb_array_elements(doc->'lines') x where x->>'id' = '12'), 120, 'taxable sales are what remains after those deductions');
select is((select (x->>'dollars')::int from cdtfa, jsonb_array_elements(doc->'lines') x where x->>'id' = '13'), 7, 'state tax is 6 percent of line 12, rounded');
select is((select (x->>'dollars')::int from cdtfa, jsonb_array_elements(doc->'lines') x where x->>'id' = '16'), 0, 'Penryn has no district tax');
select is((select (doc->>'ready')::boolean from cdtfa), false, 'a shipment with no state is not ready');

select * from finish();
rollback;
