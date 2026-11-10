-- New online sales pay Paul 25% and Jacob 5%. A sale frozen at the old
-- 30/0 split stays there, including after a fee refreeze.
begin;
select plan(8);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid(); v_jacob uuid := gen_random_uuid();
  v_old bigint;
begin
  insert into auth.users (id) values (v_paul), (v_jacob);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner'), (v_jacob, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Online commission');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'online_channels', '["website"]'),
    (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_jacob_pct', '0'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values
    (v_store, 'paul', v_paul), (v_store, 'jacob', v_jacob);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values
    (v_store, v_paul, 'percent_profit', 20), (v_store, v_jacob, 'percent_profit', 10);
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('oc01', now(), v_store), ('oc02', now(), v_store), ('oc03', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at) values
    ('oc01', 'A', 'Old online', 10000, 2000, 'sold', v_store, now(), now()),
    ('oc02', 'A', 'New online', 10000, 2000, 'sold', v_store, now(), now()),
    ('oc03', 'A', 'In store', 10000, 2000, 'sold', v_store, now(), now());
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty,
    shipping_cents, processing_fee_cents, processing_fee_source) values
    (v_store, 'oc01', 10000, 0, 'website', 'card', now(), 'OC-1', null, 1, 0, 0, 'actual')
  returning id into v_old;
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
  perform set_config('test.old', v_old::text, true);
end $$;

select is((select amount_cents from public.sale_commissions where sale_id = current_setting('test.old')::bigint and employee_id = current_setting('test.paul')::uuid),
  2400, 'old online sale: Paul keeps 30% of sale minus cost');
select is((select amount_cents from public.sale_commissions where sale_id = current_setting('test.old')::bigint and employee_id = current_setting('test.jacob')::uuid),
  0, 'old online sale: Jacob stays at nothing');

update public.store_settings set value = '25'::jsonb
 where store_id = current_setting('test.store')::uuid and key = 'online_payout_pct';
update public.store_settings set value = '5'::jsonb
 where store_id = current_setting('test.store')::uuid and key = 'online_jacob_pct';

select public.payout_refreeze_ticket(
  current_setting('test.store')::uuid,
  'sale:' || current_setting('test.old'));

select is((select amount_cents from public.sale_commissions where sale_id = current_setting('test.old')::bigint and employee_id = current_setting('test.paul')::uuid),
  2400, 'refreeze after the rate change does not move the old sale off 30%');
select is((select amount_cents from public.sale_commissions where sale_id = current_setting('test.old')::bigint and employee_id = current_setting('test.jacob')::uuid),
  0, 'refreeze does not give Jacob 5% of an old online sale');

insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty,
  shipping_cents, processing_fee_cents, processing_fee_source) values
  (current_setting('test.store')::uuid, 'oc02', 10000, 0, 'website', 'card', now(), 'OC-2', null, 1, 0, 0, 'actual'),
  (current_setting('test.store')::uuid, 'oc03', 10000, 0, 'floor', 'cash', now(), 'OC-3', current_setting('test.paul')::uuid, 1, 0, 0, 'actual');

select is((select c.amount_cents from public.sale_commissions c join public.sales s on s.id = c.sale_id
  where s.sku = 'oc02' and c.employee_id = current_setting('test.paul')::uuid),
  2000, 'new online sale: Paul 25%');
select is((select c.amount_cents from public.sale_commissions c join public.sales s on s.id = c.sale_id
  where s.sku = 'oc02' and c.employee_id = current_setting('test.jacob')::uuid),
  400, 'new online sale: Jacob 5%');
select is((select c.amount_cents from public.sale_commissions c join public.sales s on s.id = c.sale_id
  where s.sku = 'oc03' and c.employee_id = current_setting('test.paul')::uuid),
  1600, 'in-store sale stays on the rule rate');
select is((select c.amount_cents from public.sale_commissions c join public.sales s on s.id = c.sale_id
  where s.sku = 'oc03' and c.employee_id = current_setting('test.jacob')::uuid),
  800, 'in-store Jacob stays at 10%');

select * from finish();
rollback;
