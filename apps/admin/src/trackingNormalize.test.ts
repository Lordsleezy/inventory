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
