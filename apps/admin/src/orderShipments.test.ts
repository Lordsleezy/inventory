import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canManualBundle,
  canUnbundle,
  countShipments,
  dedupeOrders,
  listShipments,
  shipmentLead,
  suggestBundleGroups,
} from '../../../shared/order-shipments.mjs';
import { ebayLineRepair, planEbayOrderLines, trackingUploads } from '../../../shared/ebay-order-lines.mjs';

const base = {
  channel: 'ebay',
  buyer_name: 'Ann Du',
  ship_line1: '11435 Ranchito St',
  ship_city: 'El Monte',
  ship_region: 'CA',
  ship_postal: '91732-1362',
  status: 'paid',
  fulfillment: 'ship',
  paid_at: '2026-11-10T12:30:00.000Z',
  package: { length_in: 8, width_in: 6, height_in: 4, weight_lb: 1 },
};

test('three lines stay three rows until staff bundles; tracking upload still one per eBay order', () => {
  const plan = planEbayOrderLines({
    orderId: '11-22-33',
    pricingSummary: { deliveryCost: { value: '12.00' }, priceSubtotal: { value: '45.00' } },
    lineItems: [
      { lineItemId: 'A', sku: '99763', lineItemCost: { value: '16.99' }, quantity: 1 },
      { lineItemId: 'B', sku: '99874', lineItemCost: { value: '19.80' }, quantity: 1 },
      { lineItemId: 'C', sku: '99871', lineItemCost: { value: '20.90' }, quantity: 1 },
    ],
  }, { weights: { '99763': 1, '99874': 2, '99871': 3 } });
  assert.equal(plan.plans.length, 3);
  const rows = plan.plans.map((row, i) => ({
    id: `r${i}`,
    ...base,
    sku: row.sku,
    order_no: plan.orderId,
    payment_id: row.paymentId,
    shipping_cents: row.shipCents,
    item_cents: row.itemCents,
    length_in: 8, width_in: 6, height_in: 4, weight_lb: i + 1,
  }));
  const ships = listShipments(rows);
  assert.equal(ships.length, 3);
  assert.equal(ships.every((ship) => !ship.bundled), true);
  assert.equal(countShipments(rows), 3);
  assert.equal(trackingUploads(rows).length, 1);
  const again = ebayLineRepair(plan.plans, rows.map((r) => ({
    sku: r.sku, payment_id: r.payment_id, shipping_cents: r.shipping_cents, status: 'paid',
  })));
  assert.equal(again.inserts.length, 0);
});

test('repair path after a single-line import only inserts the missing lines once', () => {
  const plan = planEbayOrderLines({
    orderId: '04-15422-45863',
    pricingSummary: { deliveryCost: { value: '3.98' }, priceSubtotal: { value: '36.79' } },
    lineItems: [
      { lineItemId: '10085883493704', sku: '99763', lineItemCost: { value: '16.99' } },
      { lineItemId: '10085883493804', sku: '99874', lineItemCost: { value: '19.80' } },
    ],
  }, { weights: { '99763': 1, '99874': 2 } });
  const first = ebayLineRepair(plan.plans, [{
    id: 'legacy', sku: '99763', payment_id: 'ebay:04-15422-45863', shipping_cents: 398, status: 'paid',
  }]);
  assert.deepEqual(first.inserts.map((row) => row.sku), ['99874']);
  const after = [
    { sku: '99763', payment_id: 'ebay:04-15422-45863', shipping_cents: first.shipping[0]?.shipping_cents ?? 0, status: 'paid' },
    { sku: '99874', payment_id: plan.plans[1].paymentId, shipping_cents: plan.plans[1].shipCents, status: 'paid' },
  ];
  const second = ebayLineRepair(plan.plans, after);
  assert.equal(second.inserts.length, 0);
});

test('same buyer/address is a suggestion, not an automatic merge', () => {
  const rows = [
    { id: 'a', sku: '99763', order_no: '04-15422-45863', shipping_cents: 133, item_cents: 1699, ...base, weight_lb: 1, length_in: 6, width_in: 4, height_in: 3 },
    { id: 'b', sku: '99874', order_no: '04-15422-45863', shipping_cents: 265, item_cents: 1980, ...base, weight_lb: 2, length_in: 10, width_in: 8, height_in: 6 },
    { id: 'c', sku: '99871', order_no: '04-15422-45862', shipping_cents: 1208, item_cents: 2090, ...base, weight_lb: 3, length_in: 8, width_in: 8, height_in: 8 },
  ];
  assert.equal(listShipments(rows).length, 3);
  const tips = suggestBundleGroups(rows);
  assert.equal(tips.length, 1);
  assert.equal(tips[0].itemCount, 3);
  assert.equal(tips[0].buyer, 'Ann Du');
});

test('manual links collapse to one shipment; duplicates in the portal list are dropped', () => {
  const rows = [
    { id: 'a', sku: '99763', order_no: '1', shipping_cents: 133, item_cents: 1699, ...base, weight_lb: 1, length_in: 6, width_in: 4, height_in: 3 },
    { id: 'a', sku: '99763', order_no: '1', shipping_cents: 133, item_cents: 1699, ...base, weight_lb: 1, length_in: 6, width_in: 4, height_in: 3 },
    { id: 'b', sku: '99874', order_no: '1', shipping_cents: 265, item_cents: 1980, ...base, weight_lb: 2, length_in: 10, width_in: 8, height_in: 6 },
    { id: 'c', sku: '99871', order_no: '2', shipping_cents: 1208, item_cents: 2090, ...base, weight_lb: 3, length_in: 8, width_in: 8, height_in: 8 },
  ];
  assert.equal(dedupeOrders(rows).length, 3);
  const linked = listShipments(rows, {
    links: [
      { order_id: 'a', peer_id: 'b' },
      { order_id: 'b', peer_id: 'c' },
      { order_id: 'a', peer_id: 'c' },
    ],
  });
  assert.equal(linked.length, 1);
  assert.equal(linked[0].bundled, true);
  assert.equal(linked[0].itemCount, 3);
  assert.equal(shipmentLead(linked[0].items)?.sku, '99763');
});

test('manual bundle blocks different buyers and a labeled shipment', () => {
  const a = { id: '1', sku: '1', ...base };
  const b = { id: '2', sku: '2', ...base, buyer_name: 'Other Person' };
  const blocked = canManualBundle([a, b]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'different_buyer');

  const labeled = { id: '3', sku: '3', ...base, label_uploaded_at: '2026-11-10T13:00:00.000Z' };
  const withLabel = canManualBundle([a, labeled]);
  assert.equal(withLabel.ok, false);
  assert.equal(withLabel.reason, 'label_exists');
  assert.equal(canUnbundle([a, labeled]).ok, false);
  assert.equal(canUnbundle([a, { id: '4', sku: '4', ...base }]).ok, true);
});

test('tab counts count unbundled lines until a manual bundle exists', () => {
  const rows = [
    { id: 'a', sku: '99763', order_no: '1', shipping_cents: 100, item_cents: 1000, ...base },
    { id: 'b', sku: '99874', order_no: '1', shipping_cents: 100, item_cents: 1000, ...base },
    { id: 'c', sku: '99999', order_no: '2', shipping_cents: 100, item_cents: 1000, ...base, buyer_name: 'Someone Else', ship_line1: '1 Other St' },
  ];
  assert.equal(countShipments(rows), 3);
  assert.equal(countShipments(rows, { links: [{ order_id: 'a', peer_id: 'b' }] }), 2);
});

test('books keep per-line sale amounts after a manual bundle', () => {
  const rows = [
    { id: 'a', sku: '99763', order_no: '1', shipping_cents: 133, item_cents: 1699, ...base, weight_lb: 1, length_in: 6, width_in: 4, height_in: 3 },
    { id: 'b', sku: '99874', order_no: '1', shipping_cents: 265, item_cents: 1980, ...base, weight_lb: 2, length_in: 10, width_in: 8, height_in: 6 },
  ];
  const ship = listShipments(rows, { links: [{ order_id: 'a', peer_id: 'b' }] })[0];
  const itemTotal = ship.items.reduce((n: number, row: { item_cents?: number }) => n + Number(row.item_cents || 0), 0);
  const shipTotal = ship.items.reduce((n: number, row: { shipping_cents?: number }) => n + Number(row.shipping_cents || 0), 0);
  assert.equal(itemTotal, 1699 + 1980);
  assert.equal(shipTotal, 133 + 265);
  assert.equal(ship.itemCount, 2);
});
