import { json, serviceClient } from '../lib/server.mjs';
import { wrapHandler } from '../lib/floor-log.mjs';
import { withLock, dbBusy } from '../lib/bg-guard.mjs';
const parts = new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'});
function dayAt(offset){const d=new Date(Date.now()+offset*86400000);return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
function laMidnight(day){const [y,m,d]=day.split('-').map(Number);let t=Date.UTC(y,m-1,d,8);for(let i=0;i<3;i++){const p=Object.fromEntries(parts.formatToParts(new Date(t)).map(x=>[x.type,Number(x.value)]));t+=Date.UTC(y,m-1,d)-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);}return new Date(t).toISOString();}
async function handle(){
 if(!process.env.RESEND_API_KEY)return json(200,{skipped:'email_not_configured'});
 try{const sb=serviceClient();const result=await withLock('marketplace-daily-report',600,async()=>{
  if(await dbBusy(sb))return{skipped:'database_busy'};
  const yesterday=dayAt(-1),today=dayAt(0),start=laMidnight(yesterday),end=laMidnight(today);
  const {data:stores,error:storeError}=await sb.from('stores').select('id');if(storeError)throw storeError;
  const reports=[];
  for(const store of stores||[]){
   const [{data:sales},{data:ship},{data:pickup},{data:delists},{data:review}]=await Promise.all([
    sb.from('sales').select('sku,channel,price_cents,sold_at').eq('store_id',store.id).gte('sold_at',start).lt('sold_at',end).is('voided_at',null).limit(100),
    sb.from('web_orders').select('order_no,sku,ship_by,status').eq('store_id',store.id).eq('status','paid').eq('fulfillment','ship').is('shipped_at',null).or(`ship_by.is.null,ship_by.lte.${today}`).limit(50),
    sb.from('web_orders').select('order_no,sku').eq('store_id',store.id).eq('status','paid').eq('fulfillment','pickup').is('picked_up_at',null).limit(50),
    sb.from('delist_tasks').select('sku,channel').eq('store_id',store.id).is('completed_at',null).neq('channel','ebay').limit(50),
    sb.from('marketplace_email_sales').select('sku,item_title,marketplace').eq('store_id',store.id).eq('state','needs_review').limit(50)
   ]);
   const {data:activeListings}=await sb.from('listings').select('sku,channel').eq('store_id',store.id).eq('status','listed').neq('channel','ebay').limit(250);
   const skus=[...new Set((activeListings||[]).map(x=>x.sku))];
   const {data:states}=skus.length?await sb.from('units').select('sku,state').eq('store_id',store.id).in('sku',skus):{data:[]};
   const sold=new Set((states||[]).filter(x=>x.state!=='available').map(x=>x.sku));
   const [{data:gIndex},{data:catalog}]=await Promise.all([
    sb.from('google_product_index').select('sku').eq('store_id',store.id).limit(500),
    sb.from('storefront_items').select('sku').eq('store_id',store.id).eq('shippable',true).limit(500)
   ]);
   const current=new Set((catalog||[]).map(x=>x.sku));
   const mismatch=[...(activeListings||[]).filter(x=>sold.has(x.sku)).map(x=>`SKU ${x.sku} sold in Floor but listed on ${x.channel}`),...(gIndex||[]).filter(x=>!current.has(x.sku)).map(x=>`SKU ${x.sku} in Google but not shippable/available in Floor`)];
   reports.push({sales:sales||[],ship:ship||[],pickup:pickup||[],delists:delists||[],review:review||[],mismatch});
  }
  const lines=[];
  for(const x of reports){
   lines.push('Sold yesterday: '+(x.sales.length?x.sales.map(s=>`${s.sku} ${s.channel} $${(s.price_cents/100).toFixed(2)}`).join(', '):'none'));
   lines.push('Ship today: '+(x.ship.length?x.ship.map(s=>`${s.order_no} SKU ${s.sku} by ${s.ship_by||'deadline missing'}`).join(', '):'none'));
   lines.push('Pickup waiting: '+(x.pickup.length?x.pickup.map(s=>`${s.order_no} SKU ${s.sku}`).join(', '):'none'));
   lines.push('Delist alerts: '+(x.delists.length?x.delists.map(s=>`${s.sku} ${s.channel}`).join(', '):'none'));
   lines.push('Sales needing review: '+(x.review.length?x.review.map(s=>`${s.marketplace} SKU ${s.sku||'unknown'} ${s.item_title||''}`).join(', '):'none'));
   lines.push('Mismatches: '+(x.mismatch.length?x.mismatch.join('; '):'none'));
  }
  const cfg=(await sb.from('store_settings').select('value').eq('key','order_notify_emails').limit(1)).data?.[0]?.value||['paul@sentinelprime.org'];
  const to=(Array.isArray(cfg)?cfg:[]).filter(x=>String(x).includes('@'));if(!to.length)to.push('paul@sentinelprime.org');
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${process.env.RESEND_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({from:process.env.EMAIL_FROM||'Floor <orders@openboxindustries.com>',to,subject:`Floor daily sales inbox � ${yesterday}`,text:lines.join('\n\n')})});
  if(!response.ok)throw new Error(`Resend ${response.status}`);return{sent:true};
 });return json(200,result);}catch(e){return json(500,{error:String(e).slice(0,300)});}
}
export const handler=wrapHandler('marketplace-daily-report',handle);
