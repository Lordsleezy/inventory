import test from 'node:test';
import assert from 'node:assert/strict';
import { carrierTrackUrl, orderCanStepBack, orderChip, orderStage, orderTimeline, packagedStale, shippedStale } from './orderStage.ts';

const day = '2026-11-07T21:14:00Z';

test('orderCanStepBack only on paid orders with a fulfillment timestamp', () => {
  assert.equal(orderCanStepBack({ status: 'paid', fulfillment: 'ship' }), false);
  assert.equal(orderCanStepBack({ status: 'paid', fulfillment: 'ship', packaged_at: day }), true);
  assert.equal(orderCanStepBack({ status: 'canceled', fulfillment: 'ship', packaged_at: day }), false);
});

test('ebay and unlabeled depop wait in Needs label; other channels still buy', () => {
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', channel: 'ebay' }), 'needsLabel');
  assert.equal(orderChip({ status: 'paid', fulfillment: 'ship', channel: 'ebay' }).text, 'Upload label');
  assert.equal(orderChip({ status: 'paid', fulfillment: 'ship', channel: 'ebay', marketplace_tracking_number: '9400111899001234567891' }).text, 'Label bought in eBay — upload PDF');
  assert.equal(orderChip({ status: 'paid', fulfillment: 'ship', channel: 'ebay', label_storage_path: 'a/b.pdf', label_tracking_mismatch: true }).text, "Wrong label · doesn't match eBay");
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', channel: 'depop' }), 'needsLabel');
  assert.equal(orderChip({ status: 'paid', fulfillment: 'ship', channel: 'depop', label_storage_path: 'a/b.pdf', label_origin: 'upload' }).text, 'Label ready · Print');
  assert.equal(orderChip({ status: 'paid', fulfillment: 'ship', channel: 'tiktok' }).text, 'Buy label');
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', channel: 'ebay', ebay_seller_username: 'pgg124-5' }), 'toShip');
});

test('packaged over two days without a shipped tap is flagged', () => {
  const o = { status: 'paid', fulfillment: 'ship', packaged_at: '2026-11-01T18:00:00Z' };
  assert.equal(packagedStale(o, Date.parse('2026-11-04T18:00:01Z')), true);
  assert.equal(orderChip(o, Date.parse('2026-11-04T18:00:01Z')).text, 'Not marked shipped · 2+ days');
  assert.equal(packagedStale({ ...o, shipped_at: day }, Date.parse('2026-11-09T18:00:00Z')), false);
});

test('shipped over ten days without a delivered tap is flagged', () => {
  const o = { status: 'paid', fulfillment: 'ship', packaged_at: '2026-10-01T18:00:00Z', shipped_at: '2026-10-02T18:00:00Z' };
  assert.equal(shippedStale(o, Date.parse('2026-10-12T18:00:01Z')), true);
  assert.equal(orderChip(o, Date.parse('2026-10-12T18:00:01Z')).text, 'Not delivered · 10+ days');
  assert.equal(shippedStale({ ...o, delivered_at: '2026-10-12T12:00:00Z' }, Date.parse('2026-10-20T18:00:00Z')), false);
});

test('track links open the carrier page and do not call an API', () => {
  assert.match(carrierTrackUrl('9400111899223344556677') || '', /usps\.com/);
  assert.match(carrierTrackUrl('1Z999AA10123456784') || '', /ups\.com/);
  assert.match(carrierTrackUrl('123456789012') || '', /fedex\.com/);
  assert.equal(carrierTrackUrl(''), null);
});

test('delivered replaces done, and pickup data still has a stage', () => {
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', delivered_at: day }), 'delivered');
  assert.equal(orderStage({ status: 'paid', fulfillment: 'pickup' }), 'pickup');
  assert.equal(orderStage({ status: 'paid', fulfillment: 'pickup', picked_up_at: day }), 'delivered');
  assert.equal(orderChip({ status: 'paid', fulfillment: 'pickup', picked_up_at: day }).text, 'Picked up');
});

test('timeline order is newest first and names who packaged', () => {
  const rows = orderTimeline({
    label_purchased_at: '2026-11-07T18:00:00Z',
    label_origin: 'bought',
    carrier: 'USPS',
    service: 'Ground Advantage',
    label_cost_cents: 694,
    packaged_at: '2026-11-07T20:50:00Z',
    packaged_by_name: 'Jacob',
  }, [{ status: 'TRANSIT', status_detail: 'Accepted at USPS', location: 'Penryn CA', occurred_at: '2026-11-07T23:31:00Z' }]);
  assert.equal(rows[0].title, 'Accepted at USPS');
  assert.equal(rows.find((r) => r.title === 'Packaged')?.detail, 'by Jacob');
  const marked = orderTimeline({
    packaged_at: '2026-11-07T20:50:00Z',
    packaged_by_name: 'Jacob',
    shipped_at: '2026-11-08T16:00:00Z',
    shipped_by_name: 'Jacob',
    delivered_at: '2026-11-12T16:00:00Z',
    delivered_by_name: 'Paul',
  });
  assert.equal(marked.find((r) => r.title === 'Shipped')?.detail, 'by Jacob');
  assert.equal(marked.find((r) => r.title === 'Delivered')?.detail, 'by Paul');
  assert.equal(rows.some((r) => r.title === 'Label bought'), true);
});
