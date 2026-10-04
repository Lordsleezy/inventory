import { serviceClient, json, corsHeaders } from '../lib/server.mjs';
import { scanWorkerHeader } from '../lib/video-scan-auth.mjs';

export async function handler(event) {
  if(event.httpMethod==='OPTIONS')return {statusCode:204,headers:corsHeaders(),body:''};
  if(event.httpMethod!=='POST')return json(405,{error:'POST required'});
  let authorizedJobId;
  try{
    const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
    const id=JSON.parse(event.body||'{}').id;
    if(!token||!/^[0-9a-f-]{36}$/i.test(String(id)))return json(400,{error:'Invalid scan request'});
    const sb=serviceClient();
    const {data:auth,error:authError}=await sb.auth.getUser(token);
    if(authError||!auth.user)return json(401,{error:'Sign in required'});
    const {data:job,error:jobError}=await sb.from('video_scan_jobs').select('id,created_by,status,still_paths,store_id,updated_at').eq('id',id).single();
    if(jobError||job.created_by!==auth.user.id)return json(404,{error:'Scan not found'});
    authorizedJobId=id;
    if(job.status==='processing') {
      if(Date.now()-Date.parse(job.updated_at)<150_000)return json(200,{ok:true,status:'processing'});
      const expired=await sb.from('video_scan_jobs').update({status:'failed',reserved_usd:0,
        error:'Identification timed out. Retry this scan.',updated_at:new Date().toISOString()})
        .eq('id',id).eq('status','processing');
      if(expired.error)throw expired.error;
      job.status='failed';
    }
    if(!['queued','failed'].includes(job.status))return json(200,{ok:true,status:job.status});
    if(!job.still_paths?.length)return json(400,{error:'No scan photo'});
    // Confirm the first still is readable before kicking the background worker.
    const file=await sb.storage.from('video-scan-staging').info(job.still_paths[0]);
    if(file.error)return json(400,{error:'Upload scan photo before starting'});
    const updated=await sb.from('video_scan_jobs').update({status:'processing',error:null,reserved_usd:0.25,
      updated_at:new Date().toISOString()})
      .eq('id',id).eq('status',job.status).select('id').maybeSingle();
    if(updated.error)throw updated.error;
    if(!updated.data)return json(200,{ok:true,status:'processing'});
    const url=`${process.env.URL||'https://inventoryobi.netlify.app'}/.netlify/functions/video-scan-background`;
    const started=await fetch(url,{method:'POST',headers:{'X-Floor-Scan-Worker':scanWorkerHeader(id),'Content-Type':'application/json'},body:JSON.stringify({id})});
    if(!started.ok)throw new Error(`Background scan could not start (${started.status})`);
    return json(202,{ok:true,id,status:'processing'});
  }catch(error){
    if(authorizedJobId)
      await serviceClient().from('video_scan_jobs').update({status:'failed',reserved_usd:0,error:String(error.message||error).slice(0,500)})
        .eq('id',authorizedJobId).eq('status','processing');
    return json(500,{error:error.message||String(error)});
  }
}
