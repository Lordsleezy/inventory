import test from 'node:test';
import assert from 'node:assert/strict';
import { notForSaleBrandError, receiveMediaWaived, receiveMissingFields, receiveSectionForGap } from './receive-validation.ts';

test('do not list waives the photo and the dimensions', () => {
  assert.equal(receiveMediaWaived(true, false), true);
  assert.deepEqual(receiveMissingFields({ doNotList: true, brandReady: false, hasPhoto: false, quantityOk: false, hasDimensions: false }), ['quantity']);
  assert.deepEqual(receiveMissingFields({ doNotList: true, brandReady: true, hasPhoto: false, quantityOk: true, hasDimensions: false }), []);
  assert.deepEqual(receiveMissingFields({
    doNotList: true, brandReady: false, hasPhoto: false, quantityOk: true, hasDimensions: false, titleOnly: true, titleReady: false,
  }), ['title']);
  assert.deepEqual(receiveMissingFields({
    doNotList: true, brandReady: false, hasPhoto: false, quantityOk: true, hasDimensions: false, titleOnly: true, titleReady: true,
  }), []);
});

test('defective alone waives the photo and the dimensions', () => {
  assert.equal(receiveMediaWaived(false, true), true);
  assert.deepEqual(receiveMissingFields({
    doNotList: false, defective: true, brandReady: true, otherGaps: ['price'], hasPhoto: false, hasDimensions: false,
  }), ['price']);
});

test('a normal receive requires a person photo and dimensions', () => {
  assert.deepEqual(receiveMissingFields({
    doNotList: false, defective: false, brandReady: true, otherGaps: ['price'], hasPhoto: false, hasDimensions: false,
  }), ['price', 'dimensions', 'photo']);
  assert.deepEqual(receiveMissingFields({
    doNotList: false, brandReady: true, otherGaps: [], hasPhoto: true, hasDimensions: true,
  }), []);
});

test('a stock photo does not count as the required photo', () => {
  assert.ok(receiveMissingFields({
    doNotList: false, brandReady: true, hasPhoto: false, hasDimensions: true,
  }).includes('photo'));
});

test('not-for-sale brand is not a separate gate anymore', () => {
  assert.equal(notForSaleBrandError(true, false), null);
  assert.equal(notForSaleBrandError(false, false), null);
});

test('missing fields open the matching section', () => {
  assert.equal(receiveSectionForGap('photo'), 'photos');
  assert.equal(receiveSectionForGap('dimensions'), 'size');
  assert.equal(receiveSectionForGap('price'), 'price');
  assert.equal(receiveSectionForGap('brand'), 'item');
});
