import test from 'node:test';
import assert from 'node:assert/strict';
import { receiveBrowsePrices } from './ebay-catalog.mjs';
import { comparablePrices } from './receive-price.mjs';

test('Browse falls back from unmatched GTIN results to rich keywords and excludes foreign currency', async () => {
  const oldFetch=globalThis.fetch;
  const keys=['EBAY_CLIENT_ID','EBAY_CLIENT_SECRET','EBAY_ENV','EBAY_DISABLED'];
  const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{EBAY_CLIENT_ID:'test-app',EBAY_CLIENT_SECRET:'test-secret',EBAY_ENV:'production',EBAY_DISABLED:'0'});
  const identity={upc:'037000962564',brand:'Febreze',model:'Air Mist',title:'Febreze Air Mist Linen & Sky 8.8 oz',size:'8.8 oz',variant:'Linen & Sky',unit_count:1};
  const calls=[];
  globalThis.fetch=async input=>{
    const url=new URL(input);calls.push(url);
    if(url.pathname.includes('oauth2/token'))return {ok:true,json:async()=>({access_token:'test-token',expires_in:7200})};
    const title=url.searchParams.has('gtin')?'Febreze Air Mist Linen & Sky 24 oz':identity.title;
    return {ok:true,json:async()=>({itemSummaries:[
      {title,price:{value:'3.49',currency:'USD'},itemWebUrl:'https://www.ebay.com/itm/1',condition:'New'},
      {title,price:{value:'9.99',currency:'CAD'},itemWebUrl:'https://www.ebay.ca/itm/2'},
    ]})};
  };
  try{
    const prices=await receiveBrowsePrices(identity);
    assert.equal(calls.length,3);
    assert.equal(calls[1].searchParams.get('gtin'),identity.upc);
    assert.match(calls[2].searchParams.get('q'),/Febreze.*Air Mist.*8\.8 oz/);
    assert.equal(prices.length,2);
    assert.equal(comparablePrices(prices,identity).length,1);
    globalThis.fetch=async()=>({ok:false,status:429,json:async()=>({})});
    await assert.rejects(receiveBrowsePrices(identity),/ebay_browse_429/);
  }finally{
    globalThis.fetch=oldFetch;
    for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];
  }
});
