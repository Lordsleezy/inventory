-- Buyer-keeps refunds reduce owner profit and do not void the sale.
-- Worker commissions are not clawed back on returns.
begin;
select plan(15);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid(); v_jacob uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul), (v_jacob);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner'), (v_jacob, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Returns Store');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'commission_store_absorbs_fees', to_jsonb(true)),
    (v_store, 'online_channels', '["website","ebay","mercari"]'),
    (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values (v_store, 'paul', v_paul), (v_store, 'jacob', v_jacob);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values
    (v_store, v_paul, 'percent_profit', 20), (v_store, v_jacob, 'percent_profit', 10);
  insert into public.sku_ledger (sku, issued_at, store_id) select s, now(), v_store from unnest(array['11482','11483']) s;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at) values
    ('11482', 'Kirkland', 'Water filters', 2999, 900, 'available', v_store, now(), now()),
    ('11483', 'Kirkland', 'Second filters', 2999, 900, 'available', v_store, now(), now());
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $q$select public.portal_mercari_record_sale('11482', 1999, 199, 808, (now() at time zone 'America/Los_Angeles')::date, null)$q$,
  'first sale is recorded');
select lives_ok(
  $q$select public.portal_mercari_record_sale('11483', 1999, 199, 808, (now() at time zone 'America/Los_Angeles')::date, null)$q$,
  'second sale is recorded');

select throws_ok(
  $q$select public.portal_start_returns(
    jsonb_build_array(
      jsonb_build_object('sale_id', (select id from public.sales where sku = '11482'), 'qty', 1),
      jsonb_build_object('sale_id', (select id from public.sales where sku = '11483'), 'qty', 1)
    ), 0, 'seller', null, 'other', false, 0)$q$,
  '22023',
  null,
  'two sales from different orders cannot share a return');

select lives_ok(
  $q$select public.portal_start_returns(
    jsonb_build_array(jsonb_build_object('sale_id', (select id from public.sales where sku = '11482'), 'qty', 1)),
    250, 'seller', 'label on the way', 'defective', false, 400)$q$,
  'a partial refund opens on the sale that is coming back');

select is((select voided_at is null from public.sales where sku = '11482'), true, 'buyer-side partial refund does not void the sale');
select is((select buyer_keep_refund_cents from public.sales where sku = '11482'), 400, 'the refund is stored on the sale');
select is((select profit_cents from public.sale_ledger where sku = '11482'),
  (select profit_cents from public.sale_ledger where sku = '11483') - 400,
  'profit drops by the refund and not by the label');
select is((select amount_cents from public.portal_expenses where external_id = 'return-label:' || (select id::text from public.returns where sku = '11482')),
  250, 'a label I paid is a Returns expense');
select is((select count(*) from public.portal_expenses where source = 'return' and amount_cents = 400 and voided_at is null),
  0::bigint, 'the refund itself is not a second expense');
select is((select count(*)::int from public.portal_payout_adjustments a
    join public.sales s on s.id = a.sale_id where s.sku = '11482'),
  0, 'keep-refund does not claw worker commissions');
select is((select c.amount_cents from public.sale_commissions c join public.sales s on s.id = c.sale_id
    where s.sku = '11482' and c.employee_id = current_setting('test.paul')::uuid) > 0, true,
  'worker commission on the sale stays intact');

select lives_ok(
  $q$do $body$
    declare v_sale bigint; v_comm int; v_return uuid;
    begin
      select s.id, c.amount_cents into v_sale, v_comm
        from public.sales s
        join public.sale_commissions c on c.sale_id = s.id and c.employee_id = current_setting('test.paul')::uuid
       where s.sku = '11483';
      insert into public.portal_payout_payments (store_id, employee_id, amount_cents, paid_by, legacy_ticket_key)
      values (current_setting('test.store')::uuid, current_setting('test.paul')::uuid, v_comm, current_setting('test.paul')::uuid, 'paid-11483');
      insert into public.returns (store_id, sku, sale_id, channel, reason, status, refund_cents, requested_qty, refunded_at)
      values (current_setting('test.store')::uuid, '11483', v_sale, 'mercari', 'defective', 'closed', 1999, 1, now())
      returning id into v_return;
      perform public.return_apply_owner_profit_refund(v_return);
      perform set_config('test.return83', v_return::text, true);
    end
  $body$$q$,
  'a full refund hits owner profit without clawing paid commission');

select is((select count(*)::int from public.portal_payout_adjustments a where a.return_id = current_setting('test.return83')::uuid),
  0, 'full refund does not create commission clawbacks');
select is((select buyer_keep_refund_cents from public.sales where sku = '11483'), 1999, 'owner profit keep-refund takes the full refund');
select is((select voided_at is null from public.sales where sku = '11483'), true, 'owner-profit refund leaves the sale unvoided so commissions stand');

select * from finish();
rollback;
