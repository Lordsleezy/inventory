import { authorizedScan } from '../lib/video-scan-auth.mjs';
import { identifyFramesCached, lookupRetail, retailFields, tokenCost } from '../lib/video-scan.mjs';
import { searchProductImages, imageBytes } from '../lib/visual-product-search.mjs';
import sharp from 'sharp';

export async function handler(event) {
  const payload=JSON.parse(event.body||'{}');
  const id=payload.id;
  let sb;
  let job;
  try {
    ({sb,job}=await authorizedScan(event,id));
    let identity;
    if(payload.mode==='price'){
      if(!['ready','saved'].includes(job.status)||(!job.result?.selected_option&&!payload.retry))return {statusCode:200};
      identity=job.result;
    }else{
      if(job.status!=='processing')return {statusCode:200};
      const downloaded=await Promise.all(job.still_paths.slice(0,2).map(async path=>{
        const file=await sb.storage.from('video-scan-staging').download(path);
        if(file.error||!file.data)return null;
        return Buffer.from(await file.data.arrayBuffer());
      }));
      const frames=downloaded.filter(Boolean);
      if(!frames.length)throw new Error('Scan photos missing from storage');
      const identified=await identifyFramesCached(sb,job,frames);
      identity={...identified.result,identified_at:new Date().toISOString()};
      const ready=await sb.from('video_scan_jobs').update({status:'ready',result:identity,
        model_name:process.env.GEMINI_VIDEO_MODEL||'gemini-3.8-flash',
        input_tokens:identified.input,output_tokens:identified.output,
        estimated_cost_usd:tokenCost(identified.input,identified.output),reserved_usd:0,
        updated_at:new Date().toISOString()}).eq('id',id).eq('status','processing');
      if(ready.error)throw ready.error;
      if(identity.options?.length){
        // Only ambiguous scans need candidate images; this runs after the popup is visible.
        const options=await Promise.all(identity.options.map(async option=>{
          try{
            const matches=await searchProductImages([option.brand,option.model,option.color].filter(Boolean).join(' '));
            const bytes=await imageBytes(matches[0].image);
            const thumb=await sharp(bytes).resize(112,112,{fit:'contain',background:'#fff'}).webp({quality:70}).toBuffer();
            return {...option,thumbnail_data_url:`data:image/webp;base64,${thumb.toString('base64')}`};
          }catch{return option}
        }));
        const latest=await sb.from('video_scan_jobs').select('result').eq('id',id).single();
        if(!latest.error&&latest.data.result?.options?.length)
          await sb.from('video_scan_jobs').update({result:{...latest.data.result,options}}).eq('id',id).eq('status','ready');
        return {statusCode:200};
      }
      // Mark retail start so the phone shows "Looking up…" immediately after identify.
      await sb.from('video_scan_jobs').update({result:{...identity,retail_started_at:new Date().toISOString()}})
        .eq('id',id).eq('status','ready');
    }
    // The popup is already available. Search and price may finish after the user starts typing.
    const retailStarted=Date.now();
    const retailSignal=AbortSignal.timeout(20_000);
    try {
      console.info('video_scan_retail_started',JSON.stringify({id,mode:payload.mode||'initial'}));
      const retail=await lookupRetail(sb,job,identity,{signal:retailSignal});
      const fields=retailFields(retail.prices,identity);
      const latest=await sb.from('video_scan_jobs').select('result,status,sku,input_tokens,output_tokens,search_queries').eq('id',id).single();
      if(latest.error)throw latest.error;
      const merged={...latest.data.result,...fields,retail_ready:true,retail_reused:retail.reused,
        retail_at:new Date().toISOString()};
      const input=latest.data.input_tokens+retail.input,output=latest.data.output_tokens+retail.output;
      if(!['ready','saved'].includes(latest.data.status))return {statusCode:200};
      const updated=await sb.from('video_scan_jobs').update({result:merged,input_tokens:input,output_tokens:output,
        search_queries:latest.data.search_queries+retail.queries,estimated_cost_usd:tokenCost(input,output),
        updated_at:new Date().toISOString()}).eq('id',id).in('status',['ready','saved']);
      if(updated.error)throw updated.error;
      console.info('video_scan_retail_done',JSON.stringify({id,ms:Date.now()-retailStarted,prices:retail.prices.length,queries:retail.queries}));
      if(latest.data.status==='saved'&&latest.data.sku){
        const existing=await sb.from('units').select('msrp_cents,retail_price_sources,retail_source_name,retail_source_url')
          .eq('store_id',job.store_id).eq('sku',latest.data.sku).single();
        if(existing.error)throw existing.error;
        const patch={};
        if(existing.data.msrp_cents==null&&fields.msrp_cents!=null)patch.msrp_cents=fields.msrp_cents;
        if(!existing.data.retail_price_sources?.length)patch.retail_price_sources=fields.retail_prices;
        if(!existing.data.retail_source_name)patch.retail_source_name=fields.retail_source_name;
        if(!existing.data.retail_source_url)patch.retail_source_url=fields.retail_source_url;
        if(Object.keys(patch).length){
          const unit=await sb.from('units').update(patch).eq('store_id',job.store_id).eq('sku',latest.data.sku);
          if(unit.error)throw unit.error;
        }
      }
    } catch(error) {
      const latest=await sb.from('video_scan_jobs').select('result,status').eq('id',id).single();
      if(!latest.error&&['ready','saved'].includes(latest.data.status))
        await sb.from('video_scan_jobs').update({result:{...latest.data.result,retail_ready:true,
          retail_error:String(error.message||error).slice(0,200)}}).eq('id',id).in('status',['ready','saved']);
      console.error('video_scan_retail_failed',JSON.stringify({id,ms:Date.now()-retailStarted,error:String(error.message||error).slice(0,200)}));
    }
  } catch(error) {
    console.error('video_scan_identification_failed',JSON.stringify({id,error:String(error.message||error).slice(0,300)}));
    if(job)await sb.from('video_scan_jobs').update({status:'failed',error:String(error.message||error).slice(0,500),
      reserved_usd:0,updated_at:new Date().toISOString()}).eq('id',job.id).eq('status','processing');
  }
  return {statusCode:200};
}
