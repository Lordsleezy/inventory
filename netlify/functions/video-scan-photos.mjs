import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { serviceClient, requireEnv, json, corsHeaders } from '../lib/server.mjs';

export async function handler(event) {
  if(event.httpMethod==='OPTIONS')return {statusCode:204,headers:corsHeaders(),body:''};
  if(event.httpMethod!=='POST')return json(405,{error:'POST required'});
  try{
    const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
    const {id}=JSON.parse(event.body||'{}');
    if(!token||!/^[0-9a-f-]{36}$/i.test(String(id)))return json(400,{error:'Invalid scan request'});
    const sb=serviceClient();
    const auth=await sb.auth.getUser(token);
    if(auth.error||!auth.data.user)return json(401,{error:'Sign in required'});
    const found=await sb.from('video_scan_jobs').select('id,store_id,created_by,status,sku,still_paths').eq('id',id).single();
    if(found.error||found.data.created_by!==auth.data.user.id||found.data.status!=='saved')return json(404,{error:'Saved scan not found'});
    const job=found.data;
    const user=createClient(requireEnv('SUPABASE_URL'),requireEnv('SUPABASE_ANON_KEY'),{
      global:{headers:{Authorization:`Bearer ${token}`}},auth:{persistSession:false,autoRefreshToken:false}
    });
    const source=sb.storage.from('video-scan-staging'),dest=sb.storage.from('unit-photos');
    let attached=0;
    for(const [index,path] of (job.still_paths||[]).entries()){
      const downloaded=await source.download(path);
      if(downloaded.error){
        // A successful previous save may already have cleaned the staging file.
        const existing=await sb.from('photos').select('id').eq('store_id',job.store_id).eq('sku',job.sku)
          .eq('path',`${job.store_id}/${job.sku}/video-${job.id}-${index}.jpg`).maybeSingle();
        if(existing.data){attached++;continue}
        throw downloaded.error;
      }
      const bytes=Buffer.from(await downloaded.data.arrayBuffer());
      const prefix=`${job.store_id}/${job.sku}`;
      const stem=`video-${job.id}-${index}`;
      const paths=[`${prefix}/${stem}.jpg`,`${prefix}/web/400/${stem}.webp`,`${prefix}/web/1200/${stem}.webp`];
      const variants=[bytes,
        await sharp(bytes).resize(400,400,{fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer(),
        await sharp(bytes).resize(1200,1200,{fit:'inside',withoutEnlargement:true}).webp({quality:84}).toBuffer()];
      for(let i=0;i<paths.length;i++){
        const up=await dest.upload(paths[i],variants[i],{contentType:i?'image/webp':'image/jpeg',upsert:true});
        if(up.error)throw up.error;
      }
      const linked=await user.rpc('video_scan_attach_photo',{p_id:id,p_path:paths[0]});
      if(linked.error)throw linked.error;
      attached++;
      await source.remove([path]);
    }
    return json(200,{ok:true,attached});
  }catch(error){return json(500,{error:error.message||String(error)})}
}
