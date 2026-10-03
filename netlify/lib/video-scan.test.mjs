import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPrices, retailFields, productKey } from './video-scan.mjs';

test('a pack price remains visible and MSRP is per unit', () => {
  const prices=cleanPrices([{store:'Target',price_cents:1999,pack_size:12,
    approximate:true,product_name:'Truly Unruly variety pack',
    url:'https://www.target.com/p/-/A-89921372'}]);
  assert.equal(prices.length,1);
  assert.equal(retailFields(prices).msrp_cents,167);
  assert.equal(prices[0].approximate,true);
});
test('rejects non-product links and keeps exact listings ahead of variants', () => {
  const fields=retailFields([
    {store:'Shop',price_cents:5000,url:'https://example.com/search?q=blender'},
    {store:'Other',price_cents:2500,url:'https://example.com/product/other',approximate:true},
    {store:'Best Buy',price_cents:9999,url:'https://example.com/product/bl610',approximate:false},
  ]);
  assert.equal(fields.retail_prices.length,2);
  assert.equal(fields.retail_source_name,'Best Buy');
  assert.equal(productKey({brand:'Ninja',model:'BL610'}),productKey({brand:'ninja',model:'bl610'}));
});
