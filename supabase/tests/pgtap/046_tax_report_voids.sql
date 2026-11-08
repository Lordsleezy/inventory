-- A voided sale is not a sale and not a refund. A logged refund on a live sale is.
begin;
select plan(6);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid(); v_jacob uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul), (v_jacob);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner'), (v_jacob, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Tax void store');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'commission_store_absorbs_fees', to_jsonb(true)),
    (v_store, 'online_channels', '["website","ebay","mercari"]'),
    (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values (v_store, 'paul', v_paul), (v_store, 'jacob', v_jacob);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values
    (v_store, v_paul, 'percent_profit', 20), (v_store, v_jacob, 'percent_profit', 10);
  insert into public.sku_ledger (sku, issued_at, store_id) select s, now(), v_store from unnest(array['94611','94612','94613']) s;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at) values
    ('94611', 'Kirkland', 'Live sale', 1999, 900, 'available', v_store, now(), now()),
    ('94612', 'Kirkland', 'Voided sale', 1999, 900, 'available', v_store, now(), now()),
    ('94613', 'Kirkland', 'Voided tax', 4000, 900, 'available', v_store, now(), now());
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $q$select public.portal_mercari_record_sale('94611', 1999, 199, 808, (now() at time zone 'America/Los_Angeles')::date, null)$q$,
  'live sale is recorded');
select lives_ok(
  $q$select public.portal_mercari_record_sale('94612', 1999, 199, 808, (now() at time zone 'America/Los_Angeles')::date, null)$q$,
  'sale that will be voided is recorded');

update public.sales set voided_at = now(), void_reason = 'cancelled, not a return'
 where sku = '94612' and store_id = current_setting('test.store')::uuid;

insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, payment_id, receipt_no, qty, sold_at, voided_at, void_reason)
values (
  current_setting('test.store')::uuid, '94613', 4000, 300, 'floor', 'cash', 'void-tax-94613', 'VT-94613', 1, now(), now(),
  'voided before anyone was paid'
);

select lives_ok(
  $q$select public.portal_start_returns(
    jsonb_build_array(jsonb_build_object('sale_id', (select id from public.sales where sku = '94611'), 'qty', 1)),
    0, 'seller', null, 'other', false, 400)$q$,
  'a partial refund is logged on the sale that still stands');

select is(
  (select coalesce(sum((x->>'sales_cents')::int), 0)::int
     from jsonb_array_elements(public.portal_tax_report((timezone('America/Los_Angeles', now()))::date) -> 'rows') x),
  1999,
  'voided sales are left out of sales');

select is(
  (select coalesce(sum((x->>'refund_sales_cents')::int), 0)::int
     from jsonb_array_elements(public.portal_tax_report((timezone('America/Los_Angeles', now()))::date) -> 'rows') x),
  400,
  'only the logged refund is a refund');

select is(
  (select coalesce(sum((x->>'tax_cents')::int), 0)::int
     from jsonb_array_elements(public.portal_tax_report((timezone('America/Los_Angeles', now()))::date) -> 'rows') x),
  coalesce((select tax_cents from public.sales where sku = '94611'), 0),
  'tax on a voided sale is not tax collected');

select * from finish();
rollback;
