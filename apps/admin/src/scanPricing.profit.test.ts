import test from 'node:test';
import assert from 'node:assert/strict';
import { ebayFeeCents, profitAfterFeesCents } from './scanPricing.ts';
import { listingLink } from './listingLink.ts';

test('ebay fee uses 13.6% plus 40¢', () => {
  assert.equal(ebayFeeCents(2000), Math.round(2000 * 0.136) + 40);
});

test('profit after fees waits for cost', () => {
  assert.equal(profitAfterFeesCents(2000, null), null);
  assert.equal(profitAfterFeesCents(2000, 500), 2000 - 500 - ebayFeeCents(2000));
});

test('listing links prefer raw URLs and build eBay item URLs', () => {
  assert.equal(listingLink('depop', 'https://www.depop.com/products/x/'), 'https://www.depop.com/products/x/');
  assert.equal(listingLink('ebay', '123456789012'), 'https://www.ebay.com/itm/123456789012');
  assert.equal(listingLink('website', null), null);
});
