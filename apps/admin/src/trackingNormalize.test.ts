import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTrackingDisplay, matchesOrderTracking, normalizeTracking, trackingExpectTail } from './trackingNormalize.ts';

test('normalizeTracking keeps core USPS number', () => {
  assert.equal(normalizeTracking('9400111899223344556601'), '9400111899223344556601');
});

test('matchesOrderTracking accepts spaced scan', () => {
  assert.equal(
    matchesOrderTracking(
      { tracking_number: '9400111899223344556601' },
      '9400 1118 9922 3344 5566 01',
    ),
    true,
  );
});

test('formatTrackingDisplay groups digits', () => {
  assert.match(formatTrackingDisplay('USPS', '9400111899223344556601'), /^USPS 9400/);
});

test('trackingExpectTail last digits', () => {
  assert.equal(trackingExpectTail({ tracking_number: '9400111899223344556601' }), '5566 01');
});

const RICE = '9434608106244728542207';
const OTHER = '9400108106244728534798';

test('a routing barcode is the tracking number printed under it', () => {
  assert.equal(normalizeTracking('(420)442362125(94)34608106244728542207'), RICE);
  assert.equal(normalizeTracking('4204423621259434608106244728542207'), RICE);
  assert.equal(normalizeTracking(`42044236${RICE}`), RICE);
  assert.equal(normalizeTracking(RICE), RICE);
  assert.equal(normalizeTracking('9434 6081 0624 4728 5422 07'), RICE);
});

test('a FedEx 34-digit barcode keeps its tracking number', () => {
  const barcode = '1111111111111111111111222222222222';
  assert.equal(barcode.length, 34);
  assert.equal(normalizeTracking(barcode), '222222222222');
});

test('scan-out ships the order whose tracking number the routing barcode ends with', () => {
  const orders = [
    { id: 'other', tracking_number: OTHER, stage: 'packaged' },
    { id: 'rice', tracking_number: RICE, stage: 'packaged' },
  ];
  const hit = orders.find((order) => matchesOrderTracking(order, '(420)442362125(94)34608106244728542207'));
  assert.equal(hit?.id, 'rice');
  const shipped = hit ? { ...hit, stage: 'shipped' } : null;
  assert.equal(shipped?.stage, 'shipped');
  assert.equal(shipped?.id, 'rice');
  assert.equal(matchesOrderTracking({ tracking_number: RICE }, '9400111899223344556601'), false);
  assert.equal(matchesOrderTracking({ tracking_number: RICE }, `42044236${OTHER}`), false);
  assert.equal(orders.find((order) => matchesOrderTracking(order, '9400111899223344556601')), undefined);
});
