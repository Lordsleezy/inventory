import test from 'node:test';
import assert from 'node:assert/strict';
import { medianReference } from './receive-price.mjs';

const item = { brand: 'Febreze', title: 'Febreze Air Mist Air Freshener Spray, Linen & Sky, 8.8 oz', variant: 'Linen & Sky', size: '8.8 oz', unit_count: 1 };
const listing = (store, cents, suffix = '') => ({ store, price_cents: cents,
  product_name: `Febreze Air Mist Linen & Sky 8.8 fl oz${suffix}`,
  url: `https://${store.toLowerCase()}.example/products/febreze-air-mist-linen-sky-8.8oz${suffix.replaceAll(' ', '-')}`,
  pack_size: 1, approximate: false });

test('median counts distinct exact whole-package listings only', () => {
  const prices = [listing('A', 299), listing('B', 399), listing('C', 499),
    { ...listing('D', 3600, ' 6 pack'), pack_size: 6 },
    { ...listing('E', 250, ' Spring Meadow'), product_name: 'Febreze Air Mist Spring Meadow 8.8 oz' },
    { ...listing('F', 250, ' 10 oz'), product_name: 'Febreze Air Mist Linen & Sky 10 oz' },
    { ...listing('A', 199), url: 'https://a.example/products/other-febreze-air-mist-linen-sky-8.8oz' }];
  const result = medianReference(prices, item);
  assert.deepEqual([result.count, result.median_cents, result.low_cents, result.high_cents], [3, 399, 299, 499]);
});

test('one or two listings do not claim a median', () => {
  const result = medianReference([listing('A', 299), listing('B', 399)], item);
  assert.equal(result.count, 2);
  assert.equal(result.median_cents, null);
});

test('a multipack is priced as the whole package, never divided', () => {
  const pack = { ...item, title: 'Febreze Air Mist Linen & Sky 8.8 oz 6 pack', unit_count: 6 };
  const prices = ['A', 'B', 'C'].map((store, index) => ({ ...listing(store, 3000 + index * 300, ' 6 pack'), pack_size: 6 }));
  const result = medianReference(prices, pack);
  assert.deepEqual([result.count, result.median_cents], [3, 3300]);
});
