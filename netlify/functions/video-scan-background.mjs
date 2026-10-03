import { serviceClient } from '../lib/server.mjs';
import { identifyFramesCached, lookupRetail, retailFields, tokenCost } from '../lib/video-scan.mjs';

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
    if(found.error||found.data.created_by!==auth.data.user.id)throw new Error('Scan not found');
    job=found.data;
    if(job.status!=='processing')return {statusCode:200};
    const frames=[];
    for(const path of job.still_paths.slice(0,2)){
      const downloaded=await sb.storage.from('video-scan-staging').download(path);
      if(downloaded.error)throw downloaded.error;
      frames.push(Buffer.from(await downloaded.data.arrayBuffer()));
    }
    const identified=await identifyFramesCached(sb,job,frames);
    const identity={...identified.result,identified_at:new Date().toISOString()};
    const ready=await sb.from('video_scan_jobs').update({status:'ready',result:identity,
      model_name:process.env.GEMINI_VIDEO_MODEL||'gemini-3.8-flash',
      input_tokens:identified.input,output_tokens:identified.output,
      estimated_cost_usd:tokenCost(identified.input,identified.output),reserved_usd:0,
      updated_at:new Date().toISOString()}).eq('id',id).eq('status','processing');
    if(ready.error)throw ready.error;
    // The popup is already available. Search and price may finish after the user starts typing.
    try {
      const retail=await lookupRetail(sb,job,identity);
      const fields=retailFields(retail.prices,identity);
      const latest=await sb.from('video_scan_jobs').select('result,status,sku,input_tokens,output_tokens,search_queries').eq('id',id).single();
      if(latest.error)throw latest.error;
      const merged={...latest.data.result,...fields,retail_ready:true,retail_reused:retail.reused,
        retail_at:new Date().toISOString()};
      const input=latest.data.input_tokens+retail.input,output=latest.data.output_tokens+retail.output;
      const updated=await sb.from('video_scan_jobs').update({result:merged,input_tokens:input,output_tokens:output,
        search_queries:latest.data.search_queries+retail.queries,estimated_cost_usd:tokenCost(input,output),
        updated_at:new Date().toISOString()}).eq('id',id);
      if(updated.error)throw updated.error;
      if(latest.data.status==='saved'&&latest.data.sku){
        const unit=await sb.from('units').update({msrp_cents:fields.msrp_cents,
          retail_price_sources:fields.retail_prices,retail_source_name:fields.retail_source_name,
          retail_source_url:fields.retail_source_url}).eq('store_id',job.store_id).eq('sku',latest.data.sku);
        if(unit.error)throw unit.error;
      }
    } catch(error) {
      await sb.from('video_scan_jobs').update({result:{...identity,retail_ready:true,retail_error:String(error.message||error).slice(0,200)}})
        .eq('id',id).eq('status','ready');
    }
  } catch(error) {
    if(job)await sb.from('video_scan_jobs').update({status:'failed',error:String(error.message||error).slice(0,500),
      reserved_usd:0,updated_at:new Date().toISOString()}).eq('id',job.id).eq('status','processing');
  }
  return {statusCode:200};
}
