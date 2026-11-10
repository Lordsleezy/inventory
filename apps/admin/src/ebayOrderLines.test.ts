import test from 'node:test';
import assert from 'node:assert/strict';
import { groupOpenOrders } from '../../../shared/bundle-shipping.mjs';
import {
  ebayLineRepair,
  planEbayOrderLines,
  refundScope,
  trackingUploads,
} from '../../../shared/ebay-order-lines.mjs';

const order = (lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  orderId: '11-22-33',
  pricingSummary: { deliveryCost: { value: '12.00' }, priceSubtotal: { value: '30.00' } },
  lineItems: lines,
  ...extra,
});

test('a one-item order keeps one row, the legacy payment id, and the whole shipping charge', () => {
  const plan = planEbayOrderLines(order([
    { lineItemId: 'L1', sku: '100', lineItemCost: { value: '30.00' }, quantity: 1 },
  ]));
  assert.equal(plan.single, true);
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].paymentId, 'ebay:11-22-33');
  assert.equal(plan.plans[0].shipCents, 1200);
  assert.equal(plan.plans[0].itemCents, 3000);
  assert.equal(plan.plans[0].feeCents, Math.round(3000 * 0.1325) + 40);
});

test('a three-item order is three rows, one shipment, and one tracking upload', () => {
  const plan = planEbayOrderLines(order([
    { lineItemId: 'A', sku: '101', lineItemCost: { value: '10.00' }, quantity: 1 },
    { lineItemId: 'B', sku: '102', lineItemCost: { value: '20.00' }, quantity: 1 },
    { lineItemId: 'C', sku: '103', lineItemCost: { value: '5.00' }, quantity: 1 },
  ]), { weights: { '101': 1, '102': 1, '103': 1 } });
  assert.equal(plan.single, false);
  assert.equal(plan.plans.length, 3);
  assert.deepEqual(plan.plans.map((row) => row.sku), ['101', '102', '103']);
  assert.deepEqual(plan.plans.map((row) => row.paymentId), [
    'ebay:11-22-33:A', 'ebay:11-22-33:B', 'ebay:11-22-33:C',
  ]);
  const ship = plan.plans.reduce((sum, row) => sum + Number(row.shipCents), 0);
  assert.equal(ship, 1200);
  assert.equal(plan.plans[0].feeCents, Math.round(1000 * 0.1325) + 40);
  assert.equal(plan.plans[1].feeCents, Math.round(2000 * 0.1325));
  const rows = plan.plans.map((row) => ({
    id: String(row.sku), channel: 'ebay', order_no: plan.orderId, buyer_name: 'Ada',
    ship_line1: '1 Main', ship_city: 'Penryn', ship_region: 'CA', ship_postal: '95663',
    status: 'paid', fulfillment: 'ship',
  }));
  assert.equal(groupOpenOrders(rows).length, 1);
  assert.equal(trackingUploads(rows).length, 1);
});

test('re-importing does not insert another row when every SKU is already stored', () => {
  const plan = planEbayOrderLines(order([
    { lineItemId: 'A', sku: '101', lineItemCost: { value: '10.00' } },
    { lineItemId: 'B', sku: '102', lineItemCost: { value: '10.00' } },
  ]), { weights: { '101': 2, '102': 2 } });
  const existing = plan.plans.map((row) => ({
    sku: row.sku, payment_id: row.paymentId, shipping_cents: row.shipCents, status: 'paid',
  }));
  const repair = ebayLineRepair(plan.plans, existing);
  assert.equal(repair.inserts.length, 0);
  assert.equal(repair.shipping.length, 0);
});

test('an order that only recorded the first SKU gains the missing lines and gives back the extra shipping', () => {
  const plan = planEbayOrderLines(order([
    { lineItemId: 'A', sku: '101', lineItemCost: { value: '10.00' } },
    { lineItemId: 'B', sku: '102', lineItemCost: { value: '10.00' } },
    { lineItemId: 'C', sku: '103', lineItemCost: { value: '10.00' } },
  ]), { weights: { '101': 1, '102': 1, '103': 1 } });
  const repair = ebayLineRepair(plan.plans, [{
    id: 'row-1', sku: '101', payment_id: 'ebay:11-22-33', shipping_cents: 1200, status: 'paid',
  }]);
  assert.deepEqual(repair.inserts.map((row) => row.sku), ['102', '103']);
  assert.equal(repair.shipping.length, 1);
  assert.equal(repair.shipping[0].sku, '101');
  assert.equal(repair.shipping[0].from_cents, 1200);
  assert.equal(repair.shipping[0].shipping_cents, 400);
});

test('a refund on one line does not name the other lines', () => {
  const partial = order([
    { lineItemId: 'A', sku: '101', refunds: [{ refundId: 'R1' }] },
    { lineItemId: 'B', sku: '102', refunds: [] },
    { lineItemId: 'C', sku: '103' },
  ], { orderPaymentStatus: 'PARTIALLY_REFUNDED' });
  assert.deepEqual(refundScope(partial), { scope: 'lines', skus: ['101'] });
  assert.deepEqual(refundScope({ ...partial, orderPaymentStatus: 'FULLY_REFUNDED' }), { scope: 'order', skus: [] });
  assert.deepEqual(
    refundScope({ ...partial, lineItems: partial.lineItems?.map((line) => ({ ...line, refunds: [] })) }),
    { scope: 'none', skus: [] },
  );
});
