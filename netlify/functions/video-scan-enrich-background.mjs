import { serviceClient } from '../lib/server.mjs';
import { enrichVideo, tokenCost } from '../lib/video-scan.mjs';

function measure(value,max=10000) {
  const n=Number(value);
  return Number.isFinite(n)&&n>0&&n<max?Math.round(n*100)/100:null;
}

export async function handler(event) {
  const id=JSON.parse(event.body||'{}').id;
  const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
  const sb=serviceClient();
  let job;
  try {
    if(!token||!/^[0-9a-f-]{36}$/i.test(String(id)))throw new Error('Invalid scan request');
    const auth=await sb.auth.getUser(token);
    if(auth.error||!auth.data.user)throw new Error('Sign in required');
    const found=await sb.from('video_scan_jobs').select('*').eq('id',id).single();
    if(found.error||found.data.created_by!==auth.data.user.id||found.data.status!=='saved'||!found.data.sku)
      throw new Error('Saved scan not found');
    job=found.data;
    if(job.result?.details_ready)return {statusCode:200};
    const downloaded=await sb.storage.from('video-scan-staging').download(job.video_path);
    if(downloaded.error)throw downloaded.error;
    const bytes=Buffer.from(await downloaded.data.arrayBuffer());
    if(bytes.length>15*1024*1024)throw new Error('Video exceeds 15 MB');
    const detail=await enrichVideo(bytes,job.video_path.endsWith('.webm')?'video/webm':'video/mp4',job.result);
    const latest=await sb.from('video_scan_jobs').select('result,input_tokens,output_tokens').eq('id',id).single();
    if(latest.error)throw latest.error;
    const result={...latest.data.result,...detail.result,details_ready:true,details_at:new Date().toISOString()};
    const dimensions=Object.fromEntries([
      'product_height_in','product_width_in','product_depth_in','product_weight_lb',
      'package_length_in','package_width_in','package_height_in','package_weight_lb'
    ].map(key=>[key,measure(detail.result[key])]));
    const hasDimensions=Object.values(dimensions).some(value=>value!==null);
    const incoming={category:detail.result.category||null,
      condition:detail.result.condition||null,defect_notes:detail.result.condition_notes||null,
      ai_description:detail.result.description||null,upc:detail.result.upc||null,
      mfr_serial:detail.result.mfr_serial||null,ebay_title:detail.result.ebay_title||null,
      ebay_category:detail.result.ebay_category||null,ebay_item_specifics:detail.result.ebay_item_specifics||{},
      ...dimensions,dims_source:hasDimensions&&['verified','estimated'].includes(detail.result.dims_source)
        ? detail.result.dims_source : null};
    const existing=await sb.from('units').select('*').eq('store_id',job.store_id).eq('sku',job.sku).single();
    if(existing.error)throw existing.error;
    const blank=value=>value===null||value===undefined||value===''||
      (typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===0);
    const patch=Object.fromEntries(Object.entries(incoming).filter(([key,value])=>!blank(value)&&blank(existing.data[key])));
    if(Object.keys(patch).length){
      const unit=await sb.from('units').update(patch).eq('store_id',job.store_id).eq('sku',job.sku);
      if(unit.error)throw unit.error;
    }
    const input=latest.data.input_tokens+detail.input,output=latest.data.output_tokens+detail.output;
    const updated=await sb.from('video_scan_jobs').update({result,input_tokens:input,output_tokens:output,
      estimated_cost_usd:tokenCost(input,output),updated_at:new Date().toISOString()}).eq('id',id);
    if(updated.error)throw updated.error;
  } catch(error) {
    if(job)await sb.from('video_scan_jobs').update({error:`Details: ${String(error.message||error).slice(0,450)}`}).eq('id',job.id);
  } finally {
    if(job?.video_path)await sb.storage.from('video-scan-staging').remove([job.video_path]);
  }
  return {statusCode:200};
}
