import { serviceClient, json, corsHeaders } from '../lib/server.mjs';
import { withLock, dbBusy } from '../lib/bg-guard.mjs';
import { merchantRequest } from '../lib/google-merchant.mjs';
import { wrapHandler } from '../lib/floor-log.mjs';

const enabled = () => process.env.GOOGLE_MERCHANT_ENABLED === 'true' && !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 && !!process.env.GOOGLE_MERCHANT_ACCOUNT_ID && !!process.env.GOOGLE_DATA_SOURCE_ID;
const gtinValid = (s) => { const x=String(s||'').replace(/\D/g,''); if(![12,13,14].includes(x.length))return false; let sum=0; for(let i=x.length-2,j=0;i>=0;i--,j++)sum+=Number(x[i])*(j%2?1:3); return (10-sum%10)%10===Number(x.at(-1)); };
const skuId = (sku) => Buffer.from(`en~US~${sku}`).toString('base64url');
async function syncOne(sb, row) {
 const {data:unit}=await sb.from('units').select('sku,title,brand,model,upc,condition,ask_cents,msrp_cents,listing_body,ai_description,defect_notes,package_weight_lb,package_length_in,package_width_in,package_height_in,state,show_on_website').eq('store_id',row.store_id).eq('sku',row.sku).maybeSingle();
 const {data:pub}=await sb.from('storefront_items').select('sku,title,brand,model,condition,ask_cents,photo_paths,listing_body,shippable').eq('store_id',row.store_id).eq('sku',row.sku).maybeSingle();
 const base=`accounts/${process.env.GOOGLE_MERCHANT_ACCOUNT_ID}/productInputs`;
 if(row.action==='delete'||!unit||!pub||unit.state!=='available'||!unit.show_on_website||!unit.ask_cents||!pub.photo_paths?.length||pub.shippable!==true){
   const existing=await sb.from('google_product_index').select('sku').eq('store_id',row.store_id).eq('sku',row.sku).maybeSingle();
   if(existing.data) { await merchantRequest(`products/v1/${base}/${skuId(row.sku)}?dataSource=${encodeURIComponent(`accounts/${process.env.GOOGLE_MERCHANT_ACCOUNT_ID}/dataSources/${process.env.GOOGLE_DATA_SOURCE_ID}`)}`,'DELETE'); await sb.from('google_product_index').delete().eq('store_id',row.store_id).eq('sku',row.sku); }
   await sb.from('google_sync_queue').delete().eq('store_id',row.store_id).eq('sku',row.sku); return 'deleted';
 }
 const photo = (p) => `https://openboxindustries.com/media/${p.split('/').map(encodeURIComponent).join('/')}`;
 const priceMicros=String(Math.round(unit.ask_cents*10000));
 const attrs={ title:pub.title||unit.title, description:(pub.listing_body||unit.ai_description||unit.defect_notes||`${pub.title||unit.title}. Open box; see condition notes.`).slice(0,5000), link:`https://openboxindustries.com/item/${encodeURIComponent(unit.sku)}`, imageLink:photo(pub.photo_paths[0]), additionalImageLinks:pub.photo_paths.slice(1,10).map(photo), availability:'IN_STOCK', condition:/new|sealed/i.test(unit.condition||'')&&!/open|damage|defect|box/i.test(unit.condition||'')?'NEW':'USED', price:{amountMicros:priceMicros,currencyCode:'USD'}, brand:unit.brand||undefined, identifierExists:Boolean(gtinValid(unit.upc)||/[A-Za-z]/.test(unit.model||'')), gtins:gtinValid(unit.upc)?[String(unit.upc).replace(/\D/g,'')]:undefined, mpn:/[A-Za-z]/.test(unit.model||'')?unit.model:undefined, shippingWeight:unit.package_weight_lb>0?{value:Number(unit.package_weight_lb),unit:'LB'}:undefined};
 const dataSource=`accounts/${process.env.GOOGLE_MERCHANT_ACCOUNT_ID}/dataSources/${process.env.GOOGLE_DATA_SOURCE_ID}`;
 await merchantRequest(`products/v1/${base}:insert?dataSource=${encodeURIComponent(dataSource)}`,'POST',{offerId:String(unit.sku),contentLanguage:'en',feedLabel:'US',productAttributes:attrs});
 await sb.from('google_product_index').upsert({store_id:row.store_id,sku:row.sku,updated_at:new Date().toISOString()});
 await sb.from('google_sync_queue').delete().eq('store_id',row.store_id).eq('sku',row.sku); return 'upserted';
}
async function handle(event){if(event.httpMethod==='OPTIONS')return{statusCode:204,headers:corsHeaders(),body:''}; if(!enabled())return json(200,{disabled:true}); try{const sb=serviceClient(); const result=await withLock('google-sync',180,async()=>{let done=0,errors=0;for(let i=0;i<15;i++){if(await dbBusy(sb))break;const {data,error}=await sb.from('google_sync_queue').select('store_id,sku,action,attempts').order('queued_at').limit(1).maybeSingle();if(error)throw error;if(!data)break;try{await syncOne(sb,data);done++;}catch(e){errors++;await sb.from('google_sync_queue').update({attempts:data.attempts+1,last_error:String(e).slice(0,500),queued_at:new Date(Date.now()+Math.min(3600000,30000*2**Math.min(data.attempts,6))).toISOString()}).eq('store_id',data.store_id).eq('sku',data.sku);break;}}return{done,errors};},sb);return json(200,result);}catch(e){return json(500,{error:String(e).slice(0,500)});}}
export const handler=wrapHandler('google-sync',handle);
