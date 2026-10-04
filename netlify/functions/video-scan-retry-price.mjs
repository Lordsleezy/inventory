import { json, corsHeaders } from '../lib/server.mjs';
import { authorizedScan, scanWorkerHeader } from '../lib/video-scan-auth.mjs';

export async function handler(event) {
  if(event.httpMethod==='OPTIONS')return {statusCode:204,headers:corsHeaders(),body:''};
  if(event.httpMethod!=='POST')return json(405,{error:'POST required'});
  try {
    const {id}=JSON.parse(event.body||'{}'),{sb,job}=await authorizedScan(event,id);
    if(!['ready','saved'].includes(job.status)||!job.result?.title)
      return json(409,{error:'No identified product to price'});
    const startedAt=new Date().toISOString();
    const updated=await sb.from('video_scan_jobs').update({result:{...job.result,retail_ready:false,
      retail_started_at:startedAt,retail_error:null}}).eq('id',id);
    if(updated.error)throw updated.error;
    const url=`${process.env.URL||'https://inventoryobi.netlify.app'}/.netlify/functions/video-scan-background`;
    const started=await fetch(url,{method:'POST',headers:{'X-Floor-Scan-Worker':scanWorkerHeader(id),'Content-Type':'application/json'},
      body:JSON.stringify({id,mode:'price',retry:true})});
    if(!started.ok)throw new Error(`Price background could not start (${started.status})`);
    console.log('video_scan_price_retry',id);
    return json(202,{ok:true});
  }catch(error){return json(400,{error:error.message||String(error)})}
}
