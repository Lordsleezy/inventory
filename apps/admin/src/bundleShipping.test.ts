import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateBundleShipping,
  allocateByWeight,
  addOrderInnerXml,
  assertBundleConfirm,
  bundleMoneyPlan,
  combinedWeightDecision,
  bundleHoldbacks,
  groupBundleReviews,
  groupOpenOrders,
  issueRefundBody,
  quoteBundle,
  sendInvoiceInnerXml,
} from '../../../shared/bundle-shipping.mjs';

const box = (id: string, extra: Record<string, unknown>) => ({
  id,
  channel: 'ebay',
  buyer_name: 'Ada Buyer',
  ship_line1: '1 Main St',
  ship_city: 'Penryn',
  ship_region: 'CA',
  ship_postal: '95663',
  status: 'paid',
  paid_at: '2026-11-09T00:00:00Z',
  fulfillment: 'ship',
  length_in: 10,
  width_in: 8,
  height_in: 4,
  weight_lb: 2,
  shipping_cents: 2000,
  item_cents: 1500,
  order_no: id,
  ...extra,
});

test('two items use the biggest box and the summed weight, then the tier', () => {
  const items = [
    box('a', { length_in: 12, width_in: 10, height_in: 6, weight_lb: 4, shipping_cents: 2000 }),
    box('b', { length_in: 8, width_in: 8, height_in: 4, weight_lb: 3, shipping_cents: 1200 }),
  ];
  const quote = quoteBundle(items);
  assert.equal(quote.ok, true);
  assert.equal(quote.package?.length_in, 12);
  assert.equal(quote.package?.weight_lb, 7);
  assert.equal(quote.size_class, 'small');
  assert.equal(quote.tier_cents, 1600);
  assert.equal(quote.price_cents, 2000);
  assert.ok(quote.price_cents >= 2000);
  assert.ok(quote.price_cents <= 3200);
});

test('three items clamp up to the most expensive single and down to the sum', () => {
  const high = [
    box('a', { weight_lb: 1, shipping_cents: 4000, length_in: 10, width_in: 8, height_in: 4 }),
    box('b', { weight_lb: 1, shipping_cents: 800, length_in: 6, width_in: 6, height_in: 4 }),
    box('c', { weight_lb: 1, shipping_cents: 700, length_in: 5, width_in: 5, height_in: 4 }),
  ];
  const up = quoteBundle(high);
  assert.equal(up.tier_cents, 1000);
  assert.equal(up.price_cents, 4000);

  const low = [
    box('a', { weight_lb: 20, shipping_cents: 1500, length_in: 16, width_in: 12, height_in: 8 }),
    box('b', { weight_lb: 8, shipping_cents: 900, length_in: 10, width_in: 8, height_in: 4 }),
    box('c', { weight_lb: 4, shipping_cents: 600, length_in: 8, width_in: 6, height_in: 4 }),
  ];
  const down = quoteBundle(low);
  assert.equal(down.package?.weight_lb, 32);
  assert.equal(down.size_class, 'medium');
  assert.equal(down.tier_cents, 4600);
  assert.equal(down.price_cents, 3000);
  assert.equal(down.separate_cents, 3000);
});

test('biggest package breaks a volume tie by the longest side', () => {
  const items = [
    box('a', { length_in: 20, width_in: 5, height_in: 2, weight_lb: 2, shipping_cents: 2000 }),
    box('b', { length_in: 10, width_in: 10, height_in: 2, weight_lb: 2, shipping_cents: 2000 }),
  ];
  const quote = quoteBundle(items);
  assert.equal(quote.package?.length_in, 20);
});

test('over the Ground Advantage limit falls back to separate shipping', () => {
  const heavy = quoteBundle([
    box('a', { weight_lb: 40, shipping_cents: 5000 }),
    box('b', { weight_lb: 31, shipping_cents: 4000 }),
  ]);
  assert.equal(heavy.ok, false);
  assert.equal(heavy.reason, 'usps_limit');
  assert.equal(heavy.flag, true);
  assert.equal(heavy.price_cents, 9000);

  const long = quoteBundle([
    box('a', { length_in: 40, width_in: 30, height_in: 20, weight_lb: 5, shipping_cents: 2000 }),
    box('b', { length_in: 8, width_in: 8, height_in: 4, weight_lb: 2, shipping_cents: 1000 }),
  ]);
  assert.equal(long.reason, 'usps_limit');
  assert.equal(long.price_cents, 3000);
});

test('grouping keeps the same buyer and address, and drops other addresses and shipped orders', () => {
  const orders = [
    box('a', {}),
    box('b', { ship_line2: 'Apt 2' }),
    box('c', { buyer_name: 'Other Person' }),
    box('d', { shipped_at: '2026-11-01T00:00:00Z' }),
    box('e', { channel: 'depop' }),
    box('f', {}),
  ];
  const groups = groupOpenOrders(orders);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((item) => item.id).sort(), ['a', 'f']);

  const split = groupOpenOrders(orders, { splitIds: ['a'] });
  assert.equal(split.length, 0);

  const linked = groupOpenOrders(
    [box('a', {}), box('g', { ship_line1: '99 Other Rd', ship_postal: '10001' })],
    { links: [{ order_id: 'a', peer_id: 'g' }] },
  );
  assert.equal(linked.length, 1);
  assert.equal(linked[0].items.length, 2);
});

test('a shipped pair stays on the approval list and an open pair does not', () => {
  const shipped = [
    box('06-15380-28307', {
      buyer_name: 'gary walczak',
      ship_line1: '1 Oak St',
      ship_postal: '95663',
      paid_at: '2026-11-01T18:25:17Z',
      shipped_at: '2026-11-02T16:00:00Z',
      length_in: 42,
      width_in: 20,
      height_in: 0.86,
      weight_lb: 4,
      shipping_cents: 3862,
    }),
    box('07-15378-29650', {
      buyer_name: 'gary walczak',
      ship_line1: '1 Oak St',
      ship_postal: '95663',
      paid_at: '2026-11-01T18:30:17Z',
      shipped_at: '2026-11-02T16:00:00Z',
      length_in: 42,
      width_in: 20,
      height_in: 0.86,
      weight_lb: 4,
      shipping_cents: 3862,
    }),
    box('open-a', {}),
    box('open-b', {}),
  ];
  const reviews = groupBundleReviews(shipped);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].buyer, 'gary walczak');
  assert.equal(reviews[0].money.action, 'refund');
  assert.equal(reviews[0].money.separate_cents, 7724);
  assert.equal(reviews[0].quote.tier_cents, 2560);
  assert.equal(reviews[0].money.bundle_cents, 3862);
  assert.equal(reviews[0].money.refund_cents, 3862);
  assert.equal(groupOpenOrders(shipped).length, 1);

  const hidden = groupBundleReviews(shipped, { appliedIds: ['06-15380-28307'] });
  assert.equal(hidden.length, 0);
});

test('shipping and label cost split by weight and add back to one box', () => {
  const items = [
    box('a', { weight_lb: 1, shipping_cents: 2000, label_cost_cents: 800 }),
    box('b', { weight_lb: 1, shipping_cents: 2000 }),
    box('c', { weight_lb: 2, shipping_cents: 2000 }),
  ];
  const quote = quoteBundle(items);
  const money = bundleMoneyPlan(items, quote);
  const allocated = Object.values(money.allocations).reduce((n, v) => n + v, 0);
  assert.equal(allocated, quote.price_cents);
  assert.ok(quote.price_cents <= 6000);
  assert.ok(quote.price_cents >= 2000);
  const labels = allocateByWeight(items, 800);
  assert.equal(Object.values(labels).reduce((n, v) => n + v, 0), 800);
  assert.equal(labels.c, 400);
});

test('a partial cancel leaves the other items as their own bundle', () => {
  const live = [
    box('a', { weight_lb: 4, shipping_cents: 2200 }),
    box('b', { weight_lb: 4, shipping_cents: 1800 }),
  ];
  const canceled = box('c', { canceled_at: '2026-11-09T00:00:00Z', weight_lb: 10, shipping_cents: 9000 });
  const groups = groupOpenOrders([...live, canceled]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.some((item) => item.id === 'c'), false);
  const again = quoteBundle(live);
  assert.equal(again.ok, true);
  assert.equal(live[0].item_cents, 1500);
  assert.equal(canceled.item_cents, 1500);
});

test('refund and invoice amounts match the one-box price, and confirm is required', () => {
  const paid = [box('a', { shipping_cents: 2000, weight_lb: 2 }), box('b', { shipping_cents: 2000, weight_lb: 2 })];
  const paidPlan = bundleMoneyPlan(paid, quoteBundle(paid));
  assert.equal(paidPlan.action, 'refund');
  assert.equal(paidPlan.refund_cents, paidPlan.separate_cents - paidPlan.bundle_cents);
  assert.equal(paidPlan.refunds.reduce((n, row) => n + row.refund_cents, 0), paidPlan.refund_cents);
  const body = issueRefundBody(paidPlan.refund_cents);
  assert.equal(body.reasonForRefund, 'SHIPPING_DISCOUNT');
  assert.equal(body.orderLevelRefundAmount.value, (paidPlan.refund_cents / 100).toFixed(2));

  const unpaid = paid.map((item) => ({ ...item, paid_at: null, status: 'pending' }));
  const invoice = bundleMoneyPlan(unpaid, quoteBundle(unpaid));
  assert.equal(invoice.action, 'invoice');
  assert.equal(invoice.invoice_cents, invoice.bundle_cents);
  const xml = addOrderInnerXml({
    lineItems: [{ legacyItemId: '111', transactionId: '222' }, { legacyItemId: '333', transactionId: '444' }],
    shippingCents: invoice.invoice_cents,
  });
  assert.match(xml, new RegExp(`<ShippingServiceCost currencyID="USD">${(invoice.invoice_cents / 100).toFixed(2)}</ShippingServiceCost>`));
  assert.match(sendInvoiceInnerXml('12-34'), /<OrderID>12-34<\/OrderID>/);

  assert.throws(() => assertBundleConfirm(false), /confirm_required/);
  assert.doesNotThrow(() => assertBundleConfirm(true));
});

test('a flat policy is not written; calculated shipping gets combined item weight', () => {
  assert.equal(combinedWeightDecision({ shippingOptions: [{ costType: 'FLAT_RATE' }] }, null).write, false);
  assert.equal(combinedWeightDecision({ shippingOptions: [{ costType: 'CALCULATED' }] }, {
    calculatedShippingRule: { combinedShippingRuleType: 'COMBINED_ITEM_WEIGHT' },
  }).reason, 'already_on');
  const decision = combinedWeightDecision({ shippingOptions: [{ costType: 'CALCULATED' }] }, { combinedDuration: 'DAYS_7' });
  assert.equal(decision.write, true);
  assert.equal(decision.body?.calculatedShippingRule.combinedShippingRuleType, 'COMBINED_ITEM_WEIGHT');
  assert.equal(decision.body?.combinedDuration, 'DAYS_7');
  assert.equal(decision.body?.calculatedHandlingRule.combinedShippingRuleType, 'INDIVIDUAL_HANDLING_FEE');
  assert.equal(decision.body?.calculatedHandlingRule.orderHandlingAmount, undefined);
});

test('orders outside the window, at different addresses, or already at the one-box price are not offered', () => {
  const early = box('old-a', { paid_at: '2026-09-01T00:00:00Z', shipping_cents: 2000 });
  const late = box('old-b', { paid_at: '2026-11-01T00:00:00Z', shipping_cents: 2000 });
  assert.equal(groupOpenOrders([early, late]).length, 0);
  const window = bundleHoldbacks([early, late]);
  assert.equal(window.length, 1);
  assert.match(window[0].reason, /30-day/);

  const other = box('addr', { ship_line1: '9 Other Rd', ship_postal: '10001', shipping_cents: 2000 });
  const here = box('here', { shipping_cents: 2000 });
  const places = bundleHoldbacks([here, other]);
  assert.equal(places.length, 1);
  assert.match(places[0].reason, /ship-to/);

  const even = [
    box('even-a', { shipped_at: '2026-11-02T00:00:00Z', weight_lb: 20, shipping_cents: 1500, length_in: 16, width_in: 12, height_in: 8 }),
    box('even-b', { shipped_at: '2026-11-02T00:00:00Z', weight_lb: 8, shipping_cents: 900, length_in: 10, width_in: 8, height_in: 4 }),
  ];
  assert.equal(groupBundleReviews(even).length, 0);
  const priced = bundleHoldbacks(even);
  assert.equal(priced.length, 1);
  assert.match(priced[0].reason, /not lower/);

  const skipped = bundleHoldbacks([early, late], { splitIds: ['old-a'] });
  assert.equal(skipped.length, 0);
});

test('a light item in a big box is billed at dimensional weight', () => {
  const items = [
    box('a', { length_in: 30, width_in: 20, height_in: 10, weight_lb: 2, shipping_cents: 5000 }),
    box('b', { length_in: 8, width_in: 6, height_in: 4, weight_lb: 1, shipping_cents: 1000 }),
  ];
  const quote = quoteBundle(items);
  assert.equal(quote.package?.weight_lb, 3);
  assert.ok(Number(quote.billed_lb) > 20);
  assert.equal(quote.size_class, 'oversize');
  assert.ok(Number(quote.tier_cents) > 1600);
});
