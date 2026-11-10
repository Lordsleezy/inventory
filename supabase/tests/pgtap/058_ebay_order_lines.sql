-- A partial refund on one line of a multi-item eBay order leaves the other line sold.
begin;
select plan(5);
set constraints all immediate;

do $$
declare s uuid;
begin
  insert into public.stores default values returning id into s;
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('98201', now(), s), ('98202', now(), s);
  insert into public.units (sku, store_id, title, state, qty_on_hand, ask_cents, acquisition_cost_cents, received_at, updated_at)
  values
    ('98201', s, 'Line A', 'sold', 1, 1000, 400, now(), now()),
    ('98202', s, 'Line B', 'sold', 1, 2000, 400, now(), now());
  insert into public.sales (store_id, sku, price_cents, channel, payment_method, payment_id, receipt_no, qty, sold_at)
  values
    (s, '98201', 1000, 'ebay', 'ebay', 'ebay:MULTI-1:A', 'EB-A', 1, now()),
    (s, '98202', 2000, 'ebay', 'ebay', 'ebay:MULTI-1:B', 'EB-B', 1, now());
  insert into public.web_orders (
    store_id, sku, sale_id, channel, order_no, status, fulfillment,
    item_cents, shipping_cents, tax_cents, total_cents
  )
  select s, sku, id, 'ebay', 'MULTI-1', 'paid', 'ship', price_cents, 400, 0, price_cents + 400
  from public.sales where store_id = s;
  insert into public.channel_orders (store_id, provider, order_id, line_item_id, sku, item_cents)
  values
    (s, 'ebay', 'MULTI-1', 'A', '98201', 1000),
    (s, 'ebay', 'MULTI-1', 'B', '98202', 2000);
  perform set_config('line_test.store', s::text, true);
end $$;

select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (select count(*)::int from public.channel_orders where order_id = 'MULTI-1'),
  2,
  'one eBay order can store a row per line item'
);

select lives_ok(
  $q$select public.floor_reconcile_ebay_line_refund(
    current_setting('line_test.store')::uuid,
    'MULTI-1',
    '98201',
    '{"orderId":"MULTI-1","orderPaymentStatus":"PARTIALLY_REFUNDED","lineItems":[{"sku":"98201","lineItemFulfillmentStatus":"FULFILLED","refunds":[{"refundId":"R1"}]},{"sku":"98202","refunds":[]}]}'
  )$q$,
  'the named line can be refunded'
);

select ok(
  (select voided_at is not null from public.sales where sku = '98201'),
  'the refunded line is voided'
);
select ok(
  (select voided_at is null from public.sales where sku = '98202'),
  'the other line stays sold'
);
select is(
  (select status from public.web_orders where sku = '98202'),
  'paid',
  'the other order row stays paid'
);

select * from finish();
rollback;
