import { randomUUID } from 'node:crypto';
import { json, corsHeaders, serviceClient, connectionAdminFromEvent } from '../lib/server.mjs';
import { wrapHandler } from '../lib/floor-log.mjs';
async function handle(event) {
  if(event.httpMethod==='OPTIONS') return {statusCode:204,headers:corsHeaders(),body:''};
  if(event.httpMethod!=='POST') return json(405,{error:'method_not_allowed'});
  try {
    const {staff}=await connectionAdminFromEvent(event,['owner','manager']);
    const body=JSON.parse(event.body||'{}');
    const sb=serviceClient();
    if(body.action==='channels'){
      const {data}=await sb.from('store_settings').select('value').eq('store_id',staff.store_id).eq('key','marketplace_channels').maybeSingle();
      return json(200,{channels:Array.isArray(data?.value)?data.value:[]});
    }
    const sku=String(body.sku||'').trim(), channel=String(body.channel||'').toLowerCase(), cents=Math.round(Number(body.price_cents));
    const {data:channels}=await sb.from('store_settings').select('value').eq('store_id',staff.store_id).eq('key','marketplace_channels').maybeSingle();
    const configured=Array.isArray(channels?.value)?channels.value:[];
    if(!/^\d{5}$/.test(sku)||!configured.some(x=>x?.key===channel)||!Number.isSafeInteger(cents)||cents<=0)return json(400,{error:'invalid_sale'});
    let messageId=`manual:${channel}:${randomUUID()}`,marketplace=channel,title=String(body.title||''),order=String(body.order_number||''),shipBy=body.ship_by||null,buyer=body.buyer||{},fulfillment=body.fulfillment==='pickup'?'pickup':'ship';
    let feeCents=body.fee_cents==null?null:Math.round(Number(body.fee_cents)),shipLabelCents=body.ship_label_cents==null?null:Math.round(Number(body.ship_label_cents)),taxCents=body.tax_cents==null?null:Math.round(Number(body.tax_cents)),payoutCents=body.payout_cents==null?null:Math.round(Number(body.payout_cents));
    if(body.action==='approve_review'){const {data:review,error}=await sb.from('marketplace_email_sales').select('*').eq('store_id',staff.store_id).eq('id',body.review_id).eq('state','needs_review').maybeSingle();if(error||!review)return json(404,{error:'review_not_found'});messageId=review.message_id;marketplace=review.marketplace||channel;title=review.item_title||title;order=review.order_number||order;shipBy=review.ship_by||shipBy;buyer=review.buyer||{};fulfillment=review.fulfillment==='pickup'?'pickup':'ship';feeCents=review.fee_cents??feeCents;shipLabelCents=review.ship_label_cents??shipLabelCents;taxCents=review.tax_cents??taxCents;payoutCents=review.payout_cents??payoutCents;}
    const {data:unit,error:uerr}=await sb.from('units').select('store_id,state').eq('sku',sku).maybeSingle();if(uerr||!unit)return json(404,{error:'unit_not_found'});if(unit.store_id!==staff.store_id)return json(403,{error:'wrong_store'});if(unit.state!=='available')return json(409,{error:'unit_not_available'});
    const {data,error}=await sb.rpc('marketplace_ingest_sale',{p_store:staff.store_id,p_sku:sku,p_channel:channel,p_price_cents:cents,p_order_number:order||messageId,p_message_id:messageId,p_marketplace:marketplace,p_item_title:title,p_ship_by:shipBy,p_fulfillment:fulfillment,p_buyer:buyer,p_confidence:1,p_fee_cents:feeCents,p_ship_label_cents:shipLabelCents,p_tax_cents:taxCents,p_payout_cents:payoutCents});if(error)throw error;return json(200,{ok:true,sale_id:data});
  }catch(e){const message=e instanceof Error?e.message:String(e);return json(message==='not_signed_in'?401:400,{error:message});}
}
export const handler=wrapHandler('marketplace-sale',handle);
