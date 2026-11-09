import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasUpcValue,
  normalizeUpc,
  upcValidationMessage,
  upcVariants,
  UPC_NOT_APPLICABLE,
} from './upcValidate.ts';

test('normalizeUpc accepts a valid UPC-A and rejects a bad check digit', () => {
  const ok = normalizeUpc('012345678905');
  assert.equal(ok.ok, true);
  assert.equal(ok.upcA, '012345678905');
  const bad = normalizeUpc('012345678906');
  assert.equal(bad.ok, false);
  assert.equal(bad.issue, 'bad check digit');
  assert.match(upcValidationMessage('012345678906') || '', /check digit/i);
});

test('hasUpcValue treats Does not apply as set', () => {
  assert.equal(hasUpcValue({ upc: null, upc_does_not_apply: true }), true);
  assert.equal(hasUpcValue({ upc: '', listing_specs: { upc: UPC_NOT_APPLICABLE } }), true);
  assert.equal(hasUpcValue({ upc: '' }), false);
  assert.equal(hasUpcValue({ upc: '012345678905' }), true);
});

test('upcVariants keeps UPC-A / EAN-13 / GTIN-14 unique', () => {
  const list = upcVariants('012345678905', { upcA: '012345678905', ean13: '0012345678905', gtin14: '00012345678905' });
  assert.deepEqual(list, ['012345678905', '0012345678905', '00012345678905']);
});
