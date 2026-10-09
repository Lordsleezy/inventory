import { serviceClient, json, corsHeaders } from '../lib/server.mjs';
import { withLock, dbBusy } from '../lib/bg-guard.mjs';
import { merchantRequest } from '../lib/google-merchant.mjs';
import { wrapHandler } from '../lib/floor-log.mjs';
import { fallbackRate } from '../lib/shippo.mjs';

const enabled = () => process.env.GOOGLE_MERCHANT_ENABLED === 'true' && !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET && !!process.env.GOOGLE_REFRESH_TOKEN && !!process.env.GOOGLE_MERCHANT_ACCOUNT_ID && !!process.env.GOOGLE_DATA_SOURCE_ID;
const gtinValid = (s) => { const x=String(s||'').replace(/\D/g,''); if(![12,13,14].includes(x.length))return false; let sum=0; for(let i=x.length-2,j=0;i>=0;i--,j++)sum+=Number(x[i])*(j%2?1:3); return (10-sum%10)%10===Number(x.at(-1)); };
const skuId = (sku) => Buffer.from(`en~US~${sku}`).toString('base64url');
const account = () => process.env.GOOGLE_MERCHANT_ACCOUNT_ID;
const dataSource = () => `accounts/${account()}/dataSources/${process.env.GOOGLE_DATA_SOURCE_ID}`;
const productParent = (sku) => `accounts/${account()}/products/${skuId(sku)}`;
const productInput = (sku) => `accounts/${account()}/productInputs/${skuId(sku)}`;
const isLargePickup = (row, unit) => Number(unit.package_weight_lb)>150 || /\b(refrigerator|fridge|freezer|dishwasher|mattresses?|washer|washing machine|clothes dryer|laundry dryer|tumble dryer|range|stove|oven|cooktop|water heater|sofa|couch|sectional|recliner|dining table|bed frame|dresser|wardrobe|armoire|pool table|treadmill|elliptical)\b/i.test(`${row.title||''} ${row.category||''}`);
export function googlePackageAttributes(unit) {
 const attrs={};
 if(Number(unit.package_weight_lb)>0)attrs.shippingWeight={value:Number(unit.package_weight_lb),unit:'lb'};
 const dims=[unit.package_length_in,unit.package_width_in,unit.package_height_in].map(Number);
 if(dims.every(n=>Number.isFinite(n)&&n>0))Object.assign(attrs,{shippingLength:{value:dims[0],unit:'in'},shippingWidth:{value:dims[1],unit:'in'},shippingHeight:{value:dims[2],unit:'in'}});
 return attrs;
}
async function removeLocalInventory(sku) {
 const storeCode=process.env.GOOGLE_STORE_CODE;
 if(!storeCode)return;
 try { await merchantRequest(`inventories/v1/${productParent(sku)}/localInventories/${encodeURIComponent(storeCode)}`,'DELETE'); }
 catch(e) { if(!String(e).includes('404')) throw e; }
}
async function removeProduct(sb,row) {
 const existing=await sb.from('google_product_index').select('sku').eq('store_id',row.store_id).eq('sku',row.sku).maybeSingle();
 if(existing.data) {
  await removeLocalInventory(row.sku);
  await merchantRequest(`products/v1/${productInput(row.sku)}?dataSource=${encodeURIComponent(dataSource())}`,'DELETE');
  await sb.from('google_product_index').delete().eq('store_id',row.store_id).eq('sku',row.sku);
 }
 await sb.from('google_sync_queue').delete().eq('store_id',row.store_id).eq('sku',row.sku);
 return 'deleted';
}
async function syncOne(sb, row) {
 const {data:unit}=await sb.from('units').select('sku,title,brand,model,upc,condition,ask_cents,shipping_cents,msrp_cents,listing_body,ai_description,defect_notes,package_weight_lb,package_length_in,package_width_in,package_height_in,state').eq('store_id',row.store_id).eq('sku',row.sku).maybeSingle();
 const {data:pub}=await sb.from('storefront_items').select('sku,title,brand,model,category,condition,ask_cents,photo_paths,listing_body,shippable').eq('store_id',row.store_id).eq('sku',row.sku).maybeSingle();
 if(row.action==='delete'||!unit||!pub||unit.state!=='available'||Number(unit.ask_cents)<=0||!pub.photo_paths?.length)return removeProduct(sb,row);
 const {data:elig}=await sb.rpc('evaluate_marketplace_eligibility',{p_store:row.store_id,p_sku:row.sku,p_channel:'website'});
 const eligRow=Array.isArray(elig)?elig[0]:elig;
 if(eligRow?.status!=='allow') {
  await sb.rpc('enqueue_eligibility_review',{p_store:row.store_id,p_sku:row.sku,p_channel:'website',p_reason:eligRow?.reason||'Website eligibility blocked'});
  return removeProduct(sb,row);
 }
 const title=String(pub.title||unit.title||`${pub.brand||unit.brand||''} ${pub.model||unit.model||''}`).trim();
 if(!title)return removeProduct(sb,row);
 const photo = (p) => `https://openboxindustries.com/media/${p.split('/').map(encodeURIComponent).join('/')}`;
 const priceMicros=String(Math.round(unit.ask_cents*10000));
 const bigPickupOnly=isLargePickup(pub,unit);
 const dimensions=[unit.package_length_in,unit.package_width_in,unit.package_height_in].map(Number);
 const completeDims=dimensions.every(n=>Number.isFinite(n)&&n>0)&&Number(unit.package_weight_lb)>0;
 const shipSettingsRes=await sb.from('store_settings').select('key,value').eq('store_id',row.store_id).in('key',['manual_shipping_tiers','manual_oversize_cents']);
 const shipSettings=Object.fromEntries((shipSettingsRes.data||[]).map(x=>[x.key,x.value]));
 const webRate=completeDims&&!bigPickupOnly?fallbackRate(shipSettings,{weight_lb:unit.package_weight_lb,length_in:unit.package_length_in,width_in:unit.package_width_in,height_in:unit.package_height_in},unit.shipping_cents):null;
 const shippable=pub.shippable===true&&!bigPickupOnly&&completeDims&&!!webRate;
 if(!shippable&&!bigPickupOnly)return removeProduct(sb,row);
 const attrs={
  title, description:(pub.listing_body||unit.listing_body||unit.ai_description||unit.defect_notes||`${title}. See condition notes and photos.`).slice(0,5000),
  link:`https://openboxindustries.com/item/${encodeURIComponent(unit.sku)}`, imageLink:photo(pub.photo_paths[0]),
  additionalImageLinks:pub.photo_paths.slice(1,10).map(photo), availability:'IN_STOCK',
  condition:/new|sealed/i.test(unit.condition||'')&&!/open|damage|defect|box|scratch|dent/i.test(unit.condition||'')?'NEW':'USED',
  price:{amountMicros:priceMicros,currencyCode:'USD'}, identifierExists:gtinValid(unit.upc),
  ...(pub.brand||unit.brand?{brand:pub.brand||unit.brand}:{}),
  ...(gtinValid(unit.upc)?{gtins:[String(unit.upc).replace(/\D/g,'')]}:{}),
  ...(unit.brand&&unit.model?{mpn:String(unit.model)}:{}),
  includedDestinations:shippable?['FREE_LISTINGS']:['FREE_LOCAL_LISTINGS'],
  excludedDestinations:shippable?['FREE_LOCAL_LISTINGS']:['FREE_LISTINGS'],
  ...(shippable?{shippingLabel:'website-shippable',shipping:[{country:'US',service:webRate.service,price:{amountMicros:String(webRate.amount_cents*10000),currencyCode:'USD'},minHandlingTime:'2',maxHandlingTime:'2'}],...googlePackageAttributes(unit)}:{}),
 };
 await merchantRequest(`products/v1/accounts/${account()}/productInputs:insert?dataSource=${encodeURIComponent(dataSource())}`,'POST',{offerId:String(unit.sku),contentLanguage:'en',feedLabel:'US',productAttributes:attrs});
 await sb.from('google_product_index').upsert({store_id:row.store_id,sku:row.sku,updated_at:new Date().toISOString()});
 if(!shippable) {
  if(!process.env.GOOGLE_STORE_CODE)throw new Error('google_store_code_missing');
  await merchantRequest(`inventories/v1/${productParent(row.sku)}/localInventories:insert`,'POST',{
   storeCode:process.env.GOOGLE_STORE_CODE,
   localInventoryAttributes:{price:{amountMicros:priceMicros,currencyCode:'USD'},availability:'IN_STOCK',pickupMethod:'BUY',pickupSla:'TWO_DAY'},
  });
 } else await removeLocalInventory(row.sku);
 await sb.from('google_sync_queue').delete().eq('store_id',row.store_id).eq('sku',row.sku); return shippable?'upserted-online':'upserted-local';
}
async function handle(event){if(event.httpMethod==='OPTIONS')return{statusCode:204,headers:corsHeaders(),body:''}; if(!enabled())return json(200,{disabled:true}); try{const sb=serviceClient(); const result=await withLock('google-sync',180,async()=>{let done=0,errors=0;for(let i=0;i<15;i++){if(await dbBusy(sb))break;const {data,error}=await sb.from('google_sync_queue').select('store_id,sku,action,attempts').order('queued_at').limit(1).maybeSingle();if(error)throw error;if(!data)break;try{await syncOne(sb,data);done++;}catch(e){errors++;await sb.from('google_sync_queue').update({attempts:data.attempts+1,last_error:String(e).slice(0,500),queued_at:new Date(Date.now()+Math.min(3600000,30000*2**Math.min(data.attempts,6))).toISOString()}).eq('store_id',data.store_id).eq('sku',data.sku);if(/Google OAuth|Merchant API 401/i.test(String(e)))break;}}return{done,errors};},sb);return json(200,result);}catch(e){return json(500,{error:String(e).slice(0,500)});}}
export const handler=wrapHandler('google-sync',handle);
