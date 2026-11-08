import test from 'node:test';
import assert from 'node:assert/strict';
import { notForSaleBrandError, receiveMissingFields } from './receive-validation.ts';

test('not-for-sale receive requires a photo and a quantity', () => {
  assert.deepEqual(receiveMissingFields({ doNotList: true, brandReady: false, hasPhoto: false, quantityOk: false }), ['photo', 'quantity']);
  assert.deepEqual(receiveMissingFields({ doNotList: true, brandReady: true, hasPhoto: false, quantityOk: true }), ['photo']);
  assert.deepEqual(receiveMissingFields({ doNotList: true, brandReady: true, hasPhoto: true, quantityOk: true }), []);
});

test('for-sale receive keeps the photo requirement and other completeness gaps', () => {
  assert.deepEqual(receiveMissingFields({ doNotList: false, brandReady: true, otherGaps: ['price'], hasPhoto: false }), ['price', 'photo']);
  assert.deepEqual(receiveMissingFields({ doNotList: false, brandReady: true, otherGaps: [], hasPhoto: true }), []);
});

test('not-for-sale brand is not a separate gate anymore', () => {
  assert.equal(notForSaleBrandError(true, false), null);
  assert.equal(notForSaleBrandError(true, true), null);
  assert.equal(notForSaleBrandError(false, false), null);
});
