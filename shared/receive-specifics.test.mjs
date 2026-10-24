import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveSpecifics } from './receive-specifics.mjs';
test('Febreze catalog MPN becomes its scent without treating ounces as count', () => {
  assert.equal(receiveSpecifics({ brand: 'Febreze', model: '96256EA',
    title: 'Febreze Odor-Fighting Air Freshener, Linen & Sky, 8.8 fl oz',
    aspects: { Scent: 'Linen & sky', Flavor: 'All', 'Number of Items': '1', 'Unit Count': '8.8', Size: '8.8 Ounce (Pack of 1)' } }), 'Linen & Sky');
});
test('photo identity adds the actual retail pack count', () => {
  assert.equal(receiveSpecifics({ model: '96256EA', variant: 'Linen & Sky', unit_count: 2, size: '8.8 oz' }), 'Linen & Sky · 2 pack');
});
test('catalog pack count and printed contents count survive', () => {
  assert.equal(receiveSpecifics({ aspects: { Flavor: 'Berry', 'Number of Items': '3' } }), 'Berry · 3 pack');
  assert.equal(receiveSpecifics({ brand: 'Acme', title: 'Acme Replacement Brush Heads 10 Pack', model: 'EB-20' }), 'Replacement Brush Heads · 10 pack');
  assert.equal(receiveSpecifics({ variant: 'Strawberry', size: '35 count', unit_count: 1 }), 'Strawberry · 35 count');
});
test('type fallback excludes codes and ignores meaningless flavors', () => {
  assert.equal(receiveSpecifics({ brand: 'Acme', title: 'Acme Garment Steamer', model: 'GS-100', aspects: { Flavor: 'All' } }), 'Garment Steamer');
  assert.equal(receiveSpecifics({ brand: 'Acme', title: 'Acme GS-100', model: 'GS-100' }), '');
});
