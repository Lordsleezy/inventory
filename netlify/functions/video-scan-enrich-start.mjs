import { json, corsHeaders } from '../lib/server.mjs';
import { authorizedScan, scanWorkerHeader } from '../lib/video-scan-auth.mjs';

export async function handler(event) {
  if(event.httpMethod==='OPTIONS')return {statusCode:204,headers:corsHeaders(),body:''};
  if(event.httpMethod!=='POST')return json(405,{error:'POST required'});
  try {
    const {id,force=false}=JSON.parse(event.body||'{}');
    const {sb,job}=await authorizedScan(event,id);
    if(job.status!=='saved')return json(404,{error:'Saved scan not found'});
    const file=await sb.storage.from('video-scan-staging').info(job.video_path);
    if(file.error&&!force)return json(409,{error:'Video upload still in progress'});
    const response=await fetch(`${process.env.URL||'https://inventoryobi.netlify.app'}/.netlify/functions/video-scan-enrich-background`,{
      method:'POST',headers:{'X-Floor-Scan-Worker':scanWorkerHeader(id),'Content-Type':'application/json'},body:JSON.stringify({id,force})});
    if(!response.ok)throw new Error(`Background enrichment could not start (${response.status})`);
    return json(202,{ok:true});
  } catch(error) {return json(500,{error:error.message||String(error)})}
}
