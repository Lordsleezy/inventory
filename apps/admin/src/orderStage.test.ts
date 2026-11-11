import test from 'node:test';
import assert from 'node:assert/strict';
import {
  carrierTrackUrl, orderCanMarkPackaged, orderCanStepBack, orderChip, orderNeedsWeightVerify,
  orderStage, orderTimeline, packagedStale, shippedStale, weightChanged,
} from './orderStage.ts';

const day = '2026-11-07T21:14:00Z';
const verified = { weight_verified_at: day, weight_verified_lb: 2.5 };

test('orderCanMarkPackaged on paid ship orders before packaged', () => {
  assert.equal(orderCanMarkPackaged({ status: 'paid', fulfillment: 'ship', ...verified }), true);
  assert.equal(orderCanMarkPackaged({ status: 'paid', fulfillment: 'ship' }), false);
  assert.equal(orderCanMarkPackaged({ status: 'paid', fulfillment: 'ship', packaged_at: '2026-01-01', ...verified }), false);
  assert.equal(orderCanMarkPackaged({ status: 'paid', fulfillment: 'ship', channel: 'ebay', ...verified }), false);
});

test('orderCanStepBack only on paid orders with a fulfillment timestamp', () => {
  assert.equal(orderCanStepBack({ status: 'paid', fulfillment: 'ship' }), false);
  assert.equal(orderCanStepBack({ status: 'paid', fulfillment: 'ship', packaged_at: day }), true);
  assert.equal(orderCanStepBack({ status: 'canceled', fulfillment: 'ship', packaged_at: day }), false);
});

test('verify weight comes before needs label and package', () => {
  assert.equal(orderNeedsWeightVerify({ status: 'paid', fulfillment: 'ship' }), true);
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', channel: 'ebay' }), 'verifyWeight');
  assert.equal(orderChip({ status: 'paid', fulfillment: 'ship', channel: 'ebay' }).text, 'Verify weight');
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', channel: 'ebay', ...verified }), 'needsLabel');
  assert.equal(orderChip({ status: 'paid', fulfillment: 'ship', channel: 'ebay', ...verified }).text, 'Upload label');
  assert.equal(orderChip({
    status: 'paid', fulfillment: 'ship', channel: 'ebay', ...verified,
    marketplace_tracking_number: '9400111899001234567891',
  }).text, 'Label bought in eBay — upload PDF');
  assert.equal(orderChip({
    status: 'paid', fulfillment: 'ship', channel: 'ebay', ...verified,
    label_storage_path: 'a/b.pdf', label_tracking_mismatch: true,
  }).text, "Wrong label · doesn't match eBay");
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', channel: 'depop' }), 'verifyWeight');
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', channel: 'depop', ...verified }), 'needsLabel');
  assert.equal(orderChip({
    status: 'paid', fulfillment: 'ship', channel: 'depop', ...verified,
    label_storage_path: 'a/b.pdf', label_origin: 'upload',
  }).text, 'Label ready · Print');
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', channel: 'tiktok' }), 'verifyWeight');
  assert.equal(orderChip({ status: 'paid', fulfillment: 'ship', channel: 'tiktok', ...verified }).text, 'Buy label');
  assert.equal(orderStage({ status: 'paid', fulfillment: 'ship', channel: 'tiktok', ...verified }), 'toShip');
  assert.equal(orderStage({
    status: 'paid', fulfillment: 'ship', channel: 'ebay', ebay_seller_username: '[REDACTED]',
  }), 'verifyWeight');
  assert.equal(orderStage({
    status: 'paid', fulfillment: 'ship', channel: 'website', ...verified,
  }), 'toShip');
  assert.equal(orderStage({
    status: 'paid', fulfillment: 'ship', channel: 'ebay', ...verified,
    label_storage_path: 'a/b.pdf', label_origin: 'upload',
  }), 'toShip');
});

test('weightChanged flags a real edit over 0.01 lb', () => {
  assert.equal(weightChanged({ weight_on_file_lb: 2.4, weight_verified_lb: 2.4 }), false);
  assert.equal(weightChanged({ weight_on_file_lb: 2.4, weight_verified_lb: 2.405 }), false);
  assert.equal(weightChanged({ weight_on_file_lb: 2.4, weight_verified_lb: 2.5 }), true);
  assert.equal(weightChanged({ weight_on_file_lb: null, weight_verified_lb: 2.5 }), false);
});

test('packaged over two days without a shipped tap is flagged', () => {
  const o = { status: 'paid', fulfillment: 'ship', packaged_at: '2026-11-01T18:00:00Z', ...verified };
  assert.equal(packagedStale(o, Date.parse('2026-11-04T18:00:01Z')), true);
  assert.equal(orderChip(o, Date.parse('2026-11-04T18:00:01Z')).text, 'Not marked shipped · 2+ days');
  assert.equal(packagedStale({ ...o, shipped_at: day }, Date.parse('2026-11-09T18:00:00Z')), false);
});

test('shipped over ten days without a delivered tap is flagged', () => {
  const o = {
    status: 'paid', fulfillment: 'ship', packaged_at: '2026-10-01T18:00:00Z',
    shipped_at: '2026-10-02T18:00:00Z', ...verified,
  };
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
    weight_verified_at: '2026-11-07T17:00:00Z',
    weight_verified_lb: 2.5,
    weight_verified_by_name: 'Jacob',
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
  assert.equal(rows.find((r) => r.title === 'Weight verified')?.detail, '2.5 lb · by Jacob');
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
