-- Shipped eBay refunds open a Returns desk row and take Paul/Jacob % out of commissions.
-- Unshipped still closes + restocks. Amount-only PARTIALLY_REFUNDED opens a partial desk row.
begin;
select plan(16);
set constraints all immediate;

do $$
declare
  s uuid;
  v_paul uuid := gen_random_uuid();
  v_jacob uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul), (v_jacob);
  insert into public.stores default values returning id into s;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, s, 'Paul', 'owner'), (v_jacob, s, 'Jacob', 'staff');
  perform public.seed_store_settings(s, 'Open returns store');
  perform public.pgtap_sync_owner_portal_admins(s);
  insert into public.store_settings (store_id, key, value) values
    (s, 'commission_store_absorbs_fees', to_jsonb(true)),
    (s, 'online_channels', '["website","ebay","mercari"]'),
    (s, 'online_payout_pct', '25'),
    (s, 'online_jacob_pct', '5'),
    (s, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values
    (s, 'paul', v_paul), (s, 'jacob', v_jacob);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values
    (s, v_paul, 'percent_profit', 20), (s, v_jacob, 'percent_profit', 10);
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('98301', now(), s), ('98302', now(), s), ('98303', now(), s);
  insert into public.units (sku, store_id, title, state, qty_on_hand, ask_cents, acquisition_cost_cents, received_at, updated_at)
  values
    ('98301', s, 'Shipped refund', 'sold', 1, 5000, 1000, now(), now()),
    ('98302', s, 'Unshipped cancel', 'sold', 1, 4000, 800, now(), now()),
    ('98303', s, 'Partial amount', 'sold', 1, 6000, 1200, now(), now());
  insert into public.sales (store_id, sku, price_cents, channel, payment_method, payment_id, receipt_no, qty, sold_at)
  values
    (s, '98301', 5000, 'ebay', 'ebay', 'ebay:SHIP-R1', 'EB-S1', 1, now()),
    (s, '98302', 4000, 'ebay', 'ebay', 'ebay:OPEN-R2', 'EB-S2', 1, now()),
    (s, '98303', 6000, 'ebay', 'ebay', 'ebay:PART-R3', 'EB-S3', 1, now());
  insert into public.web_orders (
    store_id, sku, sale_id, channel, order_no, status, fulfillment,
    item_cents, shipping_cents, tax_cents, total_cents
  )
  select s, sku, id, 'ebay',
    case sku when '98301' then 'SHIP-R1' when '98302' then 'OPEN-R2' else 'PART-R3' end,
    'paid', 'ship', price_cents, 0, 0, price_cents
  from public.sales where store_id = s;
  -- Freeze commissions so a keep-refund can refreeze Paul 25% / Jacob 5%.
  perform public.payout_snapshot_sale(id) from public.sales where store_id = s;
  perform set_config('open_ret.store', s::text, true);
  perform set_config('open_ret.paul', v_paul::text, true);
  perform set_config('open_ret.jacob', v_jacob::text, true);
end $$;

select set_config('request.jwt.claim.role', 'service_role', true);

select lives_ok(
  $q$select public.floor_reconcile_ebay_reversal(
    current_setting('open_ret.store')::uuid,
    'SHIP-R1',
    '{"orderId":"SHIP-R1","orderPaymentStatus":"FULLY_REFUNDED","orderFulfillmentStatus":"FULFILLED"}'
  )$q$,
  'shipped full refund reconciles'
);

select is(
  (select status from public.returns where sku = '98301'),
  'requested',
  'shipped refund stays Open on Returns'
);
select ok(
  (select refunded_at is not null and closed_at is null from public.returns where sku = '98301'),
  'shipped refund is stamped refunded but not closed'
);
select is(
  (select state from public.units where sku = '98301'),
  'sold',
  'shipped unit waits for Mark received'
);
select ok(
  (select voided_at is null from public.sales where sku = '98301'),
  'shipped full refund leaves the sale open'
);
select is(
  (select buyer_keep_refund_cents from public.sales where sku = '98301'),
  5000,
  'shipped full refund stores the keep-refund'
);
select is(
  (select c.amount_cents from public.sale_commissions c
   join public.sales s on s.id = c.sale_id
   where s.sku = '98301' and c.employee_id = current_setting('open_ret.paul')::uuid),
  0,
  'Paul loses his 25% after a full shipped refund'
);
select is(
  (select c.amount_cents from public.sale_commissions c
   join public.sales s on s.id = c.sale_id
   where s.sku = '98301' and c.employee_id = current_setting('open_ret.jacob')::uuid),
  0,
  'Jacob loses his 5% after a full shipped refund'
);

select lives_ok(
  $q$select public.floor_reconcile_ebay_reversal(
    current_setting('open_ret.store')::uuid,
    'OPEN-R2',
    '{"orderId":"OPEN-R2","cancelStatus":{"cancelState":"CANCELED"},"orderPaymentStatus":"FULLY_REFUNDED","orderFulfillmentStatus":"NOT_STARTED"}'
  )$q$,
  'unshipped cancel reconciles'
);
select is(
  (select status from public.returns where sku = '98302'),
  'closed',
  'unshipped cancel still closes'
);
select is(
  (select state from public.units where sku = '98302'),
  'available',
  'unshipped cancel restocks'
);

select lives_ok(
  $q$select public.floor_reconcile_ebay_amount_refund(
    current_setting('open_ret.store')::uuid,
    'PART-R3',
    1500,
    '{"orderId":"PART-R3","orderPaymentStatus":"PARTIALLY_REFUNDED","paymentSummary":{"refunds":[{"amount":{"value":"15.00"}}]}}'
  )$q$,
  'amount-only partial opens a desk row'
);
select is(
  (select status from public.returns where sku = '98303'),
  'requested',
  'partial refund stays Open'
);
select is(
  (select refund_cents from public.returns where sku = '98303'),
  1500,
  'partial refund amount is stored'
);
select ok(
  (select voided_at is null from public.sales where sku = '98303'),
  'partial refund does not void the sale'
);
select is(
  (select buyer_keep_refund_cents from public.sales where sku = '98303'),
  1500,
  'partial refund cuts owner profit'
);

select * from finish();
rollback;
