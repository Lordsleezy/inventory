import test from 'node:test';
import assert from 'node:assert/strict';
import { ebayBrandFieldName, withFloorBrandOnEbay } from './ebayBrandMap.ts';

test('Floor brand fills a blank eBay Brand aspect', () => {
  assert.equal(ebayBrandFieldName([{ name: 'Brand', required: true }, { name: 'Type' }]), 'Brand');
  assert.deepEqual(
    withFloorBrandOnEbay({ Type: 'Flashlight' }, [{ name: 'Brand', required: true }], 'Infinity X1'),
    { Type: 'Flashlight', Brand: 'Infinity X1' },
  );
});

test('an existing eBay Brand is left alone', () => {
  assert.deepEqual(
    withFloorBrandOnEbay({ Brand: 'Other' }, [{ name: 'Brand' }], 'Infinity X1'),
    { Brand: 'Other' },
  );
});

test('Brand is seeded even before aspect fields load', () => {
  assert.equal(ebayBrandFieldName([]), 'Brand');
  assert.deepEqual(withFloorBrandOnEbay({}, [], 'Infinity X1'), { Brand: 'Infinity X1' });
});
