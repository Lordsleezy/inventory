-- Shipped eBay refunds open a Returns desk row; unshipped still closes + restocks.
-- Amount-only PARTIALLY_REFUNDED opens a partial desk row without voiding the sale.
begin;
select plan(12);
set constraints all immediate;

do $$
declare s uuid;
begin
  insert into public.stores default values returning id into s;
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
  perform set_config('open_ret.store', s::text, true);
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
