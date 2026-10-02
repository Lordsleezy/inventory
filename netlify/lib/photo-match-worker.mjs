import { createHash } from "node:crypto";
import { serviceClient } from "./server.mjs";
import { imageBytes, productQuery, searchProductImages, sourceDetails, titleScore, visualScore } from "./visual-product-search.mjs";
import { photoBuffers } from "./model-lookup.mjs";

const checked = (result,label) => { if(result.error) throw new Error(`${label}: ${result.error.message}`); return result.data; };
const keyFor = (url) => createHash("sha256").update(url).digest("hex");
const now = () => new Date().toISOString();

async function ownPhoto(sb,row){
  const photos=checked(await sb.from("photos").select("path").eq("store_id",row.store_id).eq("sku",row.sku)
    .order("is_primary",{ascending:false}).order("created_at").limit(4),"own_photos");
  for(const photo of photos){try{const result=await sb.storage.from("unit-photos").download(photo.path);if(!result.error&&result.data)return {path:photo.path,bytes:Buffer.from(await result.data.arrayBuffer())};}catch{/* Try another unit photo. */}}
  throw new Error("own_photo_unavailable");
}

async function searchCached(sb,row,query){
  const previous=checked(await sb.from("photo_enrichment_searches").select("query,results,checked_at").eq("store_id",row.store_id).eq("identity_key",row.identity_key).maybeSingle(),"search_cache");
  if(previous?.query===query&&Date.now()-Date.parse(previous.checked_at)<14*86400000)return previous.results||[];
  const results=await searchProductImages(query);
  checked(await sb.from("photo_enrichment_searches").upsert({store_id:row.store_id,identity_key:row.identity_key,query,results,checked_at:now()}),"save_search");
  return results;
}

async function stageAsset(sb,row,result,allResults){
  const assetKey=keyFor(result.image);
  let asset=checked(await sb.from("photo_enrichment_assets").select("*").eq("store_id",row.store_id).eq("asset_key",assetKey).maybeSingle(),"asset_lookup");
  if(asset)return asset;
  const details=await sourceDetails(result);
  asset=checked(await sb.from("photo_enrichment_assets").insert({store_id:row.store_id,asset_key:assetKey,
    source_url:result.url,source_title:details.title,description:details.description,specs:details.specs})
    .select("*").single(),"asset_insert");
  const images=[result.image,...allResults.filter((x)=>x.url===result.url&&x.image!==result.image).map((x)=>x.image)].slice(0,3);
  const paths=[];
  for(const [index,url] of images.entries()){
    try{const buffers=await photoBuffers(url);const path=`${row.store_id}/${asset.id}/${String(index).padStart(2,"0")}.webp`;
      checked(await sb.storage.from("photo-match-candidates").upload(path,buffers.original,{contentType:"image/webp",upsert:true}),"stage_photo");paths.push(path);
    }catch(error){if(index===0)throw error;}
  }
  asset=checked(await sb.from("photo_enrichment_assets").update({candidate_paths:paths}).eq("id",asset.id).select("*").single(),"asset_paths");
  return asset;
}

export async function publishAsset(sb,asset){
  if(asset.status==="published"&&asset.public_paths?.length)return asset;
  const paths=[];
  for(const [index,candidatePath] of (asset.candidate_paths||[]).entries()){
    const downloaded=checked(await sb.storage.from("photo-match-candidates").download(candidatePath),"candidate_photo");
    const bytes=Buffer.from(await downloaded.arrayBuffer());
    // Rebuild the same public derivatives used by the existing professional photos.
    const {default:sharp}=await import("sharp");
    const base=`products/${asset.id}/model-enriched-${String(index).padStart(2,"0")}`;
    for(const [path,data] of [[`${base}.webp`,bytes],
      [`products/${asset.id}/web/400/model-enriched-${String(index).padStart(2,"0")}.webp`,await sharp(bytes).resize(400,400,{fit:"inside",withoutEnlargement:true}).webp({quality:82}).toBuffer()],
      [`products/${asset.id}/web/1200/model-enriched-${String(index).padStart(2,"0")}.webp`,await sharp(bytes).resize(1200,1200,{fit:"inside",withoutEnlargement:true}).webp({quality:84}).toBuffer()]]){
      checked(await sb.storage.from("manufacturer-photos").upload(path,data,{contentType:"image/webp",cacheControl:"31536000",upsert:true}),"publish_photo");
    }
    paths.push(`${base}.webp`);
  }
  if(!paths.length)throw new Error("candidate_has_no_images");
  return checked(await sb.from("photo_enrichment_assets").update({status:"published",public_paths:paths,published_at:now()})
    .eq("id",asset.id).select("*").single(),"publish_asset");
}

async function recordSuggestion(sb,row,asset,own,score,status){
  return checked(await sb.from("photo_enrichment_suggestions").upsert({store_id:row.store_id,sku:row.sku,
    asset_id:asset.id,own_photo_path:own.path,status,confidence:score.confidence,
    visual_score:score.visual,text_score:score.text,
    reason:`Name ${Math.round(score.text*100)}%; visual ${Math.round(score.visual*100)}%. ${status==="review"?"Confirm exact variant and color.":"Exact visual match."}`,
    decided_at:status==="approved"?now():null}, {onConflict:"store_id,sku,asset_id"}).select("id").single(),"suggestion");
}

export async function processPhotoMatch(row,sb=serviceClient()){
  const next={attempts:row.attempts+1,checked_at:now()};
  try{
    const unit=checked(await sb.from("units").select("store_id,sku,brand,model,title,category").eq("store_id",row.store_id).eq("sku",row.sku).maybeSingle(),"unit");
    if(!unit){checked(await sb.from("photo_enrichment_queue").delete().eq("store_id",row.store_id).eq("sku",row.sku),"skip_deleted");return "skipped_deleted";}
    if(String(unit.category||"").toLowerCase()==="refrigerator"){
      checked(await sb.from("photo_enrichment_queue").delete().eq("store_id",row.store_id).eq("sku",row.sku),"skip_fridge");return "skipped_fridge";
    }
    const own=await ownPhoto(sb,row);const query=productQuery(unit);const results=await searchCached(sb,row,query);
    const rejected=checked(await sb.from("photo_enrichment_suggestions").select("asset_id").eq("store_id",row.store_id).eq("sku",row.sku).eq("status","rejected"),"rejections");
    const rejectedAssets=new Set(rejected.map((x)=>x.asset_id));
    const scored=await Promise.allSettled(results.slice(0,10).map(async(result)=>{
      const existing=checked(await sb.from("photo_enrichment_assets").select("id").eq("store_id",row.store_id).eq("asset_key",keyFor(result.image)).maybeSingle(),"candidate_check");
      if(existing&&rejectedAssets.has(existing.id))return null;
      const bytes=await imageBytes(result.image);const visual=await visualScore(own.bytes,bytes);const text=titleScore(query,result.title);
      return {result,visual,text,confidence:0.55*text+0.45*visual};
    }));
    const scores=scored.flatMap((x)=>x.status==="fulfilled"&&x.value?[x.value]:[]);
    scores.sort((a,b)=>b.confidence-a.confidence);
    const useful=scores.filter((x)=>x.confidence>=0.62&&x.text>=0.72&&x.visual>=0.42).slice(0,2);
    if(!useful.length){checked(await sb.from("photo_enrichment_queue").update({...next,status:"no_match",error:"No visually plausible retailer image",next_attempt_at:new Date(Date.now()+7*86400000).toISOString()}).eq("store_id",row.store_id).eq("sku",row.sku),"no_match");return "no_match";}
    const best=useful[0];
    const modelCode=/^(?=.*[a-z])(?=.*\d)[a-z0-9-]{4,}$/i.test(String(unit.model||"").trim());
    const modelConfirmed=modelCode&&best.result.title.toLowerCase().includes(unit.model.toLowerCase());
    let bestAsset=await stageAsset(sb,row,best.result,results);
    const richDescription=bestAsset.description.length>75&&bestAsset.description!==bestAsset.source_title;
    const auto=richDescription&&(
      (modelConfirmed&&best.text>=0.94&&best.visual>=0.70)
      || (!modelCode&&best.text>=0.97&&best.visual>=0.84)
    );
    let saved=0;
    for(const score of (auto?[best]:useful)){
      try{let asset=score===best?bestAsset:await stageAsset(sb,row,score.result,results);if(auto)asset=await publishAsset(sb,asset);
        await recordSuggestion(sb,row,asset,own,score,auto?"approved":"review");saved++;
      }catch(error){if(saved===0)throw error;}
    }
    checked(await sb.from("photo_enrichment_queue").update({...next,status:auto?"matched":"review",error:null})
      .eq("store_id",row.store_id).eq("sku",row.sku),"queue_update");
    return auto?"matched":"review";
  }catch(error){
    const retry=await sb.from("photo_enrichment_queue").update({...next,status:"pending",error:String(error).slice(0,300),
      next_attempt_at:new Date(Date.now()+3600000).toISOString()}).eq("store_id",row.store_id).eq("sku",row.sku);
    if(retry.error) console.error(`Queue retry update failed for ${row.sku}: ${retry.error.message}`);
    return "retry";
  }
}

export async function runPhotoMatchBatch(limit=1,sb=serviceClient()){
  checked(await sb.rpc("enqueue_pending_photo_enrichment"),"queue_reconciliation");
  const rows=checked(await sb.from("photo_enrichment_queue").select("store_id,sku,identity_key,attempts")
    .in("status",["pending","no_match"]).lte("next_attempt_at",now()).order("next_attempt_at").limit(limit),"queue");
  const results=[];for(const row of rows)results.push({sku:row.sku,status:await processPhotoMatch(row,sb)});
  return results;
}
