import test from 'node:test';
import assert from 'node:assert/strict';
import { medianReference, verifyRetailListings, upcOfferPrices, receivePriceCacheKey } from './receive-price.mjs';

const item = { brand: 'Febreze', title: 'Febreze Air Mist Air Freshener Spray, Linen & Sky, 8.8 oz', variant: 'Linen & Sky', size: '8.8 oz', unit_count: 1 };
const listing = (store, cents, suffix = '') => ({ store, price_cents: cents,
  product_name: `Febreze Air Mist Linen & Sky 8.8 fl oz${suffix}`,
  url: `https://${store.toLowerCase()}.example/products/febreze-air-mist-linen-sky-8.8oz${suffix.replaceAll(' ', '-')}`,
  pack_size: 1, approximate: false });

test('fallback caches separate size, scent and pack even when UPC or model is shared', () => {
  const identity = {...item,model:'Air Mist',upc:'037000962564'};
  const key=receivePriceCacheKey(identity);
  assert.notEqual(key,receivePriceCacheKey({...identity,size:'24 oz'}));
  assert.notEqual(key,receivePriceCacheKey({...identity,variant:'Spring Meadow'}));
  assert.notEqual(key,receivePriceCacheKey({...identity,unit_count:3}));
  assert.equal(key,receivePriceCacheKey({...identity,brand:'FEBREZE'}));
});

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

test('recorded offers retain distinct merchants behind UPCitemdb redirects and exclude CAD', () => {
  const offers = [
    { merchant: 'Canadian store', domain: 'store.ca', price: 7.99, link: 'https://www.upcitemdb.com/offer/ca' },
    { merchant: 'US A', domain: 'a.example', price: 3.49, link: 'https://www.upcitemdb.com/offer/a' },
    { merchant: 'US B', domain: 'b.example', price: 4.49, link: 'https://www.upcitemdb.com/offer/b' },
  ];
  const prices = upcOfferPrices({ found: true, title: listing('A', 100).product_name, offers }, item);
  assert.equal(prices.length, 2);
  assert.deepEqual(prices.map(p => p.price_cents), [349,449]);
});

test('count printed in a listing establishes whole-package count and rejects a conflicting model', () => {
  assert.equal(medianReference([{...listing('A', 1999, ' 3 pack'), pack_size: undefined}], item).count, 0);
  const identity = {brand:'Philips',title:'Philips Sonicare HX7129/02',model:'HX7129/02',unit_count:2};
  const price = {store:'eBay',price_cents:4445,url:'https://ebay.com/itm/1',product_name:'Philips Sonicare HX9999/01 2 pack'};
  assert.equal(medianReference([price], identity).count, 0);
  assert.equal(medianReference([{...price,product_name:'Philips Sonicare HX7129/02 2 pack'}], identity).count, 1);
  assert.equal(medianReference([{...price,product_name:'Philips Sonicare Advanced Clean HX7129/02 2 pack'}],
    {...identity,model:'Sonicare Advanced Clean'}).count,1);
});

test('a multipack is priced as the whole package, never divided', () => {
  const pack = { ...item, title: 'Febreze Air Mist Linen & Sky 8.8 oz 6 pack', unit_count: 6 };
  const prices = ['A', 'B', 'C'].map((store, index) => ({ ...listing(store, 3000 + index * 300, ' 6 pack'), pack_size: 6 }));
  const result = medianReference(prices, pack);
  assert.deepEqual([result.count, result.median_cents], [3, 3300]);
});

test('live page must confirm exact title and listed price', async () => {
  const prices = [listing('A', 379), listing('B', 449), listing('C', 499)];
  const fetched = await verifyRetailListings(prices, item, { fetchImpl: async url => ({
    ok: true, url, headers: { get: () => 'text/html' },
    text: async () => `<title>Febreze Air Mist Linen & Sky 8.8 oz</title>${url.includes('b.example') ? '$9.99' : '$' + (url.includes('a.example') ? '3.79' : '4.99')}`,
  }) });
  assert.equal(fetched.length, 2);
  assert.deepEqual(fetched.map(x => x.store), ['A', 'C']);
});
