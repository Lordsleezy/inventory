import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTrackingDisplay, matchesOrderTracking, normalizeTracking, soleTrackingMatch, takeLabelScans, trackingExpectTail } from './trackingNormalize.ts';

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

test('a (420) ZIP and (94) barcode is the tracking number on the order', () => {
  const stored = '9434608106245773021655';
  assert.equal(normalizeTracking('(420)890113784(94)34608106245773021655'), stored);
  assert.equal(matchesOrderTracking({ tracking_number: stored }, '(420)890113784(94)34608106245773021655'), true);
  assert.equal(normalizeTracking('(420)890113784(94)34608106245773021665'), '9434608106245773021665');
});

test('parentheses do not split a tracking number that is inside the scan', () => {
  const stored = '9434608106245773021655';
  const other = '9400111899223344556601';
  assert.equal(matchesOrderTracking({ tracking_number: stored }, `(99)42089011(3784)(94)${stored.slice(2)}extra`), true);
  assert.equal(matchesOrderTracking({ tracking_number: other }, `(420)890113784(94)${stored.slice(2)}`), false);
  assert.equal(matchesOrderTracking({ tracking_number: stored.slice(-12) }, `(420)890113784(94)${stored.slice(2)}`), false);
  assert.equal(soleTrackingMatch(`${stored}${other}`, [
    { tracking_number: stored },
    { tracking_number: other },
  ]), null);
  assert.equal(soleTrackingMatch(`(420)11(94)${stored.slice(2)}`, [
    { tracking_number: stored },
    { tracking_number: other },
  ])?.tracking_number, stored);
});

test('a FedEx 34-digit barcode keeps its tracking number', () => {
  const barcode = '1111111111111111111111222222222222';
  assert.equal(barcode.length, 34);
  assert.equal(normalizeTracking(barcode), '222222222222');
});

test('FedEx door-tag with parentheses collapses to the last 12 digits', () => {
  const raw = '962208043(0000000000)000384592279027';
  assert.equal(normalizeTracking(raw), '384592279027');
  assert.equal(formatTrackingDisplay('FedEx', raw), 'FedEx 3845 9227 9027');
});

const RAQUEL_A = '(420)347621423(93)34620845500057475261';
const RAQUEL_B = '(420)347621423(93)34610793404041063832';
const TRACK_A = '9334620845500057475261';
const TRACK_B = '9334610793404041063832';

test('a (93) routing barcode is the tracking number printed under it', () => {
  assert.equal(normalizeTracking(RAQUEL_A), TRACK_A);
  assert.equal(normalizeTracking(RAQUEL_B), TRACK_B);
  assert.equal(normalizeTracking(`]C1${RAQUEL_A}`), TRACK_A);
  assert.equal(normalizeTracking(RAQUEL_A.replace(/[()]/g, '')), TRACK_A);
  assert.equal(matchesOrderTracking({ tracking_number: TRACK_A }, RAQUEL_A), true);
  assert.equal(matchesOrderTracking({ tracking_number: TRACK_B }, RAQUEL_A), false);
  assert.equal(matchesOrderTracking({ tracking_number: '9334 6208 4550 0057 4752 61' }, RAQUEL_A), true);
});

test('each label in a scanner dump is its own scan', () => {
  assert.deepEqual(takeLabelScans(`${RAQUEL_A}\n${RAQUEL_B}`).scans, [RAQUEL_A, RAQUEL_B]);
  assert.deepEqual(takeLabelScans(`${RAQUEL_A}${RAQUEL_B}`).scans, [RAQUEL_A, RAQUEL_B]);
  const zip = takeLabelScans('(420)347621423');
  assert.deepEqual(zip.scans, []);
  assert.equal(zip.held, '(420)347621423');
  const rest = takeLabelScans('(93)34620845500057475261', zip.held);
  assert.deepEqual(rest.scans, ['(420)347621423(93)34620845500057475261']);
  assert.equal(rest.held, '');
  const split = takeLabelScans(`(420)347621423\u001d(93)34620845500057475261`);
  assert.equal(normalizeTracking(split.scans[0]), TRACK_A);
  assert.equal(takeLabelScans('11332').scans[0], '11332');
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
