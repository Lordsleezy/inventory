import test from 'node:test';
import assert from 'node:assert/strict';
import { notForSaleBrandError, receiveMissingFields } from './receive-validation.ts';

test('not-for-sale receive requires only a brand, with or without a photo', () => {
  assert.deepEqual(receiveMissingFields({ doNotList: true, brandReady: false, hasPhoto: false }), ['brand']);
  assert.deepEqual(receiveMissingFields({ doNotList: true, brandReady: true, hasPhoto: false }), []);
  assert.deepEqual(receiveMissingFields({ doNotList: true, brandReady: true, hasPhoto: true }), []);
});

test('for-sale receive keeps the photo requirement and other completeness gaps', () => {
  assert.deepEqual(receiveMissingFields({ doNotList: false, brandReady: true, otherGaps: ['price'], hasPhoto: false }), ['price', 'photo']);
  assert.deepEqual(receiveMissingFields({ doNotList: false, brandReady: true, otherGaps: [], hasPhoto: true }), []);
});

test('receive blocks a missing not-for-sale brand and leaves for-sale checks unchanged', () => {
  assert.match(notForSaleBrandError(true, false) || '', /^Brand required/);
  assert.equal(notForSaleBrandError(true, true), null);
  assert.equal(notForSaleBrandError(false, false), null);
});
