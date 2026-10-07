import { authorizedScan } from '../lib/video-scan-auth.mjs';
import { enrichVideo, lookupProductSpecs, retailFields, tokenCost } from '../lib/video-scan.mjs';
import { resolveFloorCategory, loadStoredAspects, refreshCategoryAspects, prepareUnitAspects } from '../lib/ebay-catalog.mjs';
import { gtinIssue } from '../lib/gtin.mjs';

const dimensionKeys=['product_height_in','product_width_in','product_depth_in','product_weight_lb',
  'package_length_in','package_width_in','package_height_in','package_weight_lb'];
function measure(value){const n=Number(value);return Number.isFinite(n)&&n>0&&n<10000?Math.round(n*100)/100:null}
function cleanModel(value){const model=String(value||'').trim();return /\d/.test(model)&&!/^\d{5,}$/.test(model)?model:''}
function goodDescription(value,title){const text=String(value||'').trim();return text.length>String(title||'').length+25?text:''}

export async function handler(event) {
  const payload=JSON.parse(event.body||'{}');
  let sb,job,finished=false;
  try {
    ({sb,job}=await authorizedScan(event,payload.id));
    if(job.status!=='saved'||!job.sku)throw new Error('Saved scan not found');
    if(job.result?.details_ready&&!payload.force)return {statusCode:200};
    const started=Date.now();
    const photos=await sb.from('photos').select('path,id').eq('store_id',job.store_id).eq('sku',job.sku)
      .like('path',`%/video-${job.id}-%`).order('id');
    if(photos.error)throw photos.error;
    const stills=[];
    for(const path of (photos.data||[]).map(row=>row.path).slice(0,4)){
      const download=await sb.storage.from('unit-photos').download(path);
      if(!download.error)stills.push(Buffer.from(await download.data.arrayBuffer()));
    }
    if(!stills.length){for(const path of (job.still_paths||[]).slice(0,4)){
      const download=await sb.storage.from('video-scan-staging').download(path);
      if(!download.error)stills.push(Buffer.from(await download.data.arrayBuffer()));
    }}
    const video=job.video_path?await sb.storage.from('video-scan-staging').download(job.video_path):null;
    const bytes=video&&!video.error?Buffer.from(await video.data.arrayBuffer()):null;
    if(bytes?.length>15*1024*1024)throw new Error('Video exceeds 15 MB');
    if(!bytes&&!stills.length)throw new Error('Scan media has expired; add details manually');
    const identity={...job.result,model:cleanModel(job.result?.model)};
    const research=await lookupProductSpecs(sb,job,identity);
    const floorCategory=/\btoothbrush/i.test(identity.title||'')?'Electric Toothbrushes':
      /\b(?:mini|string|christmas) lights\b/i.test(identity.title||'')?'String Lights':job.result?.category;
    const mapped=resolveFloorCategory(floorCategory);
    let ebayAspects=[];
    if(mapped)try{
      ebayAspects=await loadStoredAspects(mapped.ebayCategoryId);
      if(!ebayAspects.length)ebayAspects=await refreshCategoryAspects(mapped.ebayCategoryId);
    }catch(error){console.warn('video_scan_ebay_taxonomy_unavailable',job.id,String(error.message||error).slice(0,160))}
    const detail=await enrichVideo(bytes,job.video_path?.endsWith('.webm')?'video/webm':'video/mp4',identity,
      {stills,research,ebayAspects:ebayAspects.filter(row=>row.required||row.recommended)
        .map(row=>({name:row.name,required:row.required,allowed:row.allowed.slice(0,12)}))});
    const latest=await sb.from('video_scan_jobs').select('result,input_tokens,output_tokens,search_queries').eq('id',job.id).single();
    if(latest.error)throw latest.error;
    const existing=await sb.from('units').select('*').eq('store_id',job.store_id).eq('sku',job.sku).single();
    if(existing.error)throw existing.error;
    const found=detail.result;
    const desc=goodDescription(found.description,identity.title)||goodDescription(existing.data.ai_description,identity.title);
    const sources=found.dimension_sources&&typeof found.dimension_sources==='object'?found.dimension_sources:{};
    const types=found.dimension_types&&typeof found.dimension_types==='object'?found.dimension_types:{};
    const dimensions=Object.fromEntries(dimensionKeys.map(key=>[key,measure(found[key])]));
    const accepted=Object.fromEntries(Object.entries(dimensions).filter(([key,value])=>value!==null&&
      (types[key]==='estimated'&&String(sources[key]||'').startsWith('estimated')||
       types[key]===(key.startsWith('package_')?'verified_shipping':'verified_product')&&
       String(sources[key]||'').startsWith('https://'))));
    const dimsSource=Object.keys(accepted).some(key=>types[key]==='estimated')?'estimated':
      Object.keys(accepted).length?'verified':null;
    const candidate=cleanModel(found.manufacturer_model);
    const exactSource=String(found.model_source_url||'').replace(/\/$/,'')===
      String(job.result?.retail_source_url||'').replace(/\/$/,'');
    const model=candidate&&(exactSource||candidate===cleanModel(job.result?.model))?candidate:'';
    const specifics={...(existing.data.ebay_item_specifics||{}),...(found.ebay_item_specifics||{})};
    const scannedUpc=String(found.upc||'').trim();
    const upcIssue=gtinIssue(scannedUpc);
    const existingUpc=String(existing.data.upc||'').trim();
    const specificsUpc=String(specifics.UPC||'').trim();
    const specificsIssue=gtinIssue(specificsUpc);
    const validUpc=existingUpc&&!gtinIssue(existingUpc)?existingUpc:
      scannedUpc&&!upcIssue?scannedUpc:specificsUpc&&!specificsIssue?specificsUpc:null;
    if(specificsIssue)delete specifics.UPC;
    if(/^\d{5,}$/.test(String(specifics.MPN||'')))delete specifics.MPN;
    const priorAspects={...(existing.data.listing_specs?.ebay_aspects||{})};
    if(gtinIssue(priorAspects.UPC))delete priorAspects.UPC;
    const specs={...(existing.data.listing_specs||{}),
      ...Object.fromEntries(Object.entries(accepted).filter(([key])=>key.startsWith('product_')).map(([key,value])=>[key.slice(8),value])),
      dims_sources:{...(existing.data.listing_specs?.dims_sources||{}),
        ...Object.fromEntries(Object.keys(accepted).map(key=>[key,`${types[key]}: ${String(sources[key])}`]))},
      ebay_aspects:{...priorAspects,...specifics}};
    const retail=retailFields(latest.data.result?.retail_prices||[],identity);
    const category=/\btoothbrush/i.test(identity.title||'')?'Electric Toothbrushes':
      /\b(?:mini|string|christmas) lights\b/i.test(identity.title||'')?'String Lights':
      existing.data.category||found.category||null;
    const powered=typeof found.requires_power==='boolean'?found.requires_power:
      typeof found.is_electrical==='boolean'?found.is_electrical:
      /\b(rechargeable|electric|electronic|cordless|battery|sonicare|toothbrush|bluetooth|vacuum|laptop)\b/i.test(`${identity.title||''} ${category||''}`);
    const camera=typeof found.is_camera==='boolean'?found.is_camera:
      /\b(camera|dslr|mirrorless|camcorder|gopro|webcam)\b/i.test(`${identity.title||''} ${category||''}`);
    const patch={category,
      condition:existing.data.condition||found.condition||null,
      defect_notes:existing.data.defect_notes||found.condition_notes||null,
      ai_description:desc||null,listing_body:goodDescription(existing.data.listing_body,identity.title)||desc||null,
      upc:validUpc,upc_rejected:upcIssue?scannedUpc:specificsIssue?specificsUpc:existing.data.upc_rejected||null,
      mfr_serial:existing.data.mfr_serial||found.mfr_serial||null,
      ebay_title:String(found.ebay_title||existing.data.ebay_title||'').replace(/\b\d{7}\b/g,'').replace(/\s+/g,' ').trim(),
      ebay_category:found.ebay_category||existing.data.ebay_category,
      ebay_item_specifics:specifics,
      listing_specs:specs,msrp_cents:retail.msrp_cents??existing.data.msrp_cents,
      ...Object.fromEntries(Object.entries(accepted).filter(([key])=>existing.data[key]==null)),
      dims_source:existing.data.dims_source||dimsSource,
      model:model||cleanModel(existing.data.model),
      requires_power:powered,
      is_electrical:typeof found.is_electrical==='boolean'?found.is_electrical:powered,
      is_camera:camera,
      has_manufacturer_photos:existing.data.has_manufacturer_photos||false};
    if(model){patch.ebay_item_specifics.MPN=model;patch.listing_specs.ebay_aspects.MPN=model}
    const saved=await sb.from('units').update(patch).eq('store_id',job.store_id).eq('sku',job.sku);
    if(saved.error)throw saved.error;
    const input=latest.data.input_tokens+research.input+detail.input;
    const output=latest.data.output_tokens+research.output+detail.output;
    const result={...latest.data.result,...found,details_ready:true,details_at:new Date().toISOString(),
      details_search_queries:research.queries,spec_sources:research.sources,dimension_sources:sources};
    const updated=await sb.from('video_scan_jobs').update({result,error:null,input_tokens:input,output_tokens:output,
      search_queries:latest.data.search_queries+research.queries,estimated_cost_usd:tokenCost(input,output),
      updated_at:new Date().toISOString()}).eq('id',job.id);
    if(updated.error)throw updated.error;
    if(mapped)try{
      const checked=await prepareUnitAspects({storeId:job.store_id,unit:{...existing.data,...patch}});
      if(checked.missingRequired.length)console.warn('video_scan_ebay_missing',job.id,checked.missingRequired.join(', '));
    }catch(error){console.warn('video_scan_ebay_check_failed',job.id,String(error.message||error).slice(0,160))}
    const best=Number(found.main_photo_index);
    if(Number.isInteger(best)&&best>=0&&best<(photos.data||[]).length){
      const id=(photos.data||[])[best].id;
      await sb.from('photos').update({is_primary:false}).eq('store_id',job.store_id).eq('sku',job.sku);
      await sb.from('photos').update({is_primary:true}).eq('id',id).eq('store_id',job.store_id);
    }
    console.info('video_scan_details_done',JSON.stringify({id:job.id,sku:job.sku,ms:Date.now()-started,
      searches:research.queries,dimensions:Object.keys(accepted).length,photos:stills.length}));
    finished=true;
  }catch(error){
    console.error('video_scan_details_failed',JSON.stringify({id:payload.id,error:String(error.message||error).slice(0,300)}));
    if(job&&sb)await sb.from('video_scan_jobs').update({error:`Details: ${String(error.message||error).slice(0,450)}`})
      .eq('id',job.id);
  }finally{
    if(finished&&job?.video_path)await sb.storage.from('video-scan-staging').remove([job.video_path]);
  }
  return {statusCode:200};
}
