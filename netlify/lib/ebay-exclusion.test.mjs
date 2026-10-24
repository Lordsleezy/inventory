import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEbayListable, ebayNeverList } from './ebay-exclusion.mjs';

test('per-item eBay exclusion blocks a listing without changing other channels', () => {
  const unit = { sku: '11550', listing_specs: { ebay_never_list: true, marketplace_pricing: { channels: { amazon: { do_not_list: false } } } } };
  assert.equal(ebayNeverList(unit), true);
  assert.throws(() => assertEbayListable(unit), /excluded from eBay/);
  assert.equal(unit.listing_specs.marketplace_pricing.channels.amazon.do_not_list, false);
});

test('ordinary units are still listable', () => {
  const unit = { sku: '12345', listing_specs: {} };
  assert.equal(ebayNeverList(unit), false);
  assert.doesNotThrow(() => assertEbayListable(unit));
});
