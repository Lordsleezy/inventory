-- Mercari seller-paid shipping is a reimbursement, not sale profit or commission.
begin;
select plan(12);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid(); v_jacob uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul), (v_jacob);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner'), (v_jacob, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Mercari Store');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'commission_store_absorbs_fees', 'true'),
    (v_store, 'online_channels', '["website","ebay","mercari"]'),
    (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values (v_store, 'paul', v_paul), (v_store, 'jacob', v_jacob);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values
    (v_store, v_paul, 'percent_profit', 20), (v_store, v_jacob, 'percent_profit', 10);
  insert into public.sku_ledger (sku, issued_at, store_id) select s, now(), v_store from unnest(array['11482']) s;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at) values
    ('11482', 'Kirkland', 'Water filters', 2999, 900, 'available', v_store, now(), now());
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $q$select public.portal_mercari_record_sale('11482', 1999, 199, 808, current_date, null)$q$,
  'Mercari tab records sale price, fee, and payout');

select is((select ship_label_cents from public.channel_orders where sku = '11482'), null, 'the sale stores no seller shipping');
select is((select fee_cents from public.channel_orders where sku = '11482'), 199, 'fee is the Mercari fee, not sale minus payout');
select is((select payout_cents from public.channel_orders where sku = '11482'), 808, 'payout is stored on its own');
select is((select ship_cost_cents from public.sale_ledger where sku = '11482'), 0, 'ledger ship cost ignores Mercari labels');
select is((select profit_cents from public.sale_ledger where sku = '11482'), 900, 'profit is sale - fee - cost');
select is((select amount_cents from public.sale_commissions c join public.sales s on s.id = c.sale_id
  where s.sku = '11482' and c.employee_id = current_setting('test.paul')::uuid), 330,
  'commission is 30% of sale - cost; the lower payout is not a shipping deduction');

-- A label typed onto the order becomes Paul's reimbursement and still stays out of the payout.
select lives_ok(
  $q$update public.channel_orders set ship_label_cents = 992 where sku = '11482'$q$,
  'recording a Mercari label is accepted');
select is((select ship_label_cents from public.channel_orders where sku = '11482'), null, 'the label is not kept on the sale');
select is((select amount_cents from public.portal_expenses where external_id = 'mercari-label:' || (select id::text from public.sales where sku = '11482')),
  992, 'the label is an expense');
select is((select employee_id from public.portal_expenses where external_id = 'mercari-label:' || (select id::text from public.sales where sku = '11482')),
  current_setting('test.paul')::uuid, 'the expense is reimbursed to the online payout person');
select is((select profit_cents from public.sale_ledger where sku = '11482'), 900, 'profit still ignores the label');

select * from finish();
rollback;
