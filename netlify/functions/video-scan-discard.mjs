import { json, corsHeaders } from '../lib/server.mjs';
import { authorizedScan } from '../lib/video-scan-auth.mjs';

export async function handler(event) {
  if(event.httpMethod==='OPTIONS')return {statusCode:204,headers:corsHeaders(),body:''};
  if(event.httpMethod!=='POST')return json(405,{error:'POST required'});
  try {
    const {id}=JSON.parse(event.body||'{}'),{sb,job}=await authorizedScan(event,id);
    if(job.status==='saved')return json(409,{error:'This scan already created a unit. Edit it in Inventory.'});
    const marked=await sb.from('video_scan_jobs').update({status:'discarded',reserved_usd:0,updated_at:new Date().toISOString()})
      .eq('id',id).neq('status','saved');
    if(marked.error)throw marked.error;
    const paths=[job.video_path,...(job.still_paths||[])].filter(Boolean);
    if(paths.length)await sb.storage.from('video-scan-staging').remove(paths);
    console.log('video_scan_discarded',id);
    return json(200,{ok:true});
  }catch(error){return json(400,{error:error.message||String(error)})}
}
