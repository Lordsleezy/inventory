-- An eBay sale of a sold unit writes a payout line that portal_payout_sales returns.
begin;
select plan(6);
set constraints all immediate;

do $$
declare v_store uuid; v_paul uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_paul, v_store, 'Paul', 'owner');
  insert into public.portal_admins (user_id, store_id) values (v_paul, v_store);
  perform public.seed_store_settings(v_store, 'eBay payout');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'online_channels', '["ebay","amazon","depop","website"]'),
    (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text)),
    (v_store, 'commission_store_absorbs_fees', 'true'::jsonb)
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values (v_store, 'paul', v_paul);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values
    (v_store, v_paul, 'percent_profit', 20);
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('93859', now(), v_store), ('93860', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at) values
    ('93859', 'A', 'eBay with cost', 1452, 400, 'sold', v_store, now(), now()),
    ('93860', 'A', 'eBay missing cost', 1452, null, 'sold', v_store, now(), now());
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty, shipping_cents) values
    (v_store, '93859', 1452, 0, 'ebay', 'ebay', now(), 'PAY-EBAY-1', v_paul, 1, 922),
    (v_store, '93860', 1452, 0, 'ebay', 'ebay', now(), 'PAY-EBAY-2', v_paul, 1, 922);
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select is(
  (select count(*)::int from public.sale_payout_lines pl
    join public.sales s on s.id = pl.sale_id
    where s.store_id = current_setting('test.store')::uuid and s.sku = '93859'),
  1, 'eBay sale of a sold unit writes a payout line');

select is(
  (select pl.cost_cents from public.sale_payout_lines pl
    join public.sales s on s.id = pl.sale_id
    where s.store_id = current_setting('test.store')::uuid and s.sku = '93859'),
  400, 'payout line keeps the recorded unit cost');

select is(
  (select sc.amount_cents from public.sale_commissions sc
    join public.sales s on s.id = sc.sale_id
    where s.store_id = current_setting('test.store')::uuid and s.sku = '93859'
      and sc.employee_id = current_setting('test.paul')::uuid),
  round((1452 + 922 - 400) * 0.30)::int,
  'Paul is owed 30% of price plus buyer shipping minus cost');

select ok(
  (select pl.cost_cents is null from public.sale_payout_lines pl
    join public.sales s on s.id = pl.sale_id
    where s.store_id = current_setting('test.store')::uuid and s.sku = '93860'),
  'eBay sale with no recorded cost still has a payout line');

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is(
  (select count(*)::int from public.portal_payout_sales() p where p.sku = '93859'),
  1, 'Payouts query includes the eBay sale');

select is(
  (select count(*)::int from public.portal_payout_sales() p where p.sku = '93860'),
  1, 'Payouts query includes an eBay sale that still needs a cost');

select * from finish();
rollback;
