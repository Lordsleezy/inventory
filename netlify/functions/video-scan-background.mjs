import { serviceClient } from '../lib/server.mjs';
import { analyzeVideo } from '../lib/video-scan.mjs';

export async function handler(event) {
  const id=JSON.parse(event.body||'{}').id;
  const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
  const sb=serviceClient();
  let job;
  try{
    if(!token||!/^[0-9a-f-]{36}$/i.test(String(id)))throw new Error('Invalid scan request');
    const auth=await sb.auth.getUser(token);
    if(auth.error||!auth.data.user)throw new Error('Sign in required');
    const found=await sb.from('video_scan_jobs').select('*').eq('id',id).single();
    if(found.error||found.data.created_by!==auth.data.user.id)throw new Error('Scan not found');
    job=found.data;
    if(job.status!=='processing')return {statusCode:200};
    const downloaded=await sb.storage.from('video-scan-staging').download(job.video_path);
    if(downloaded.error)throw downloaded.error;
    const bytes=Buffer.from(await downloaded.data.arrayBuffer());
    if(bytes.length>15*1024*1024)throw new Error('Video exceeds 15 MB; record a shorter clip');
    const analyzed=await analyzeVideo(sb,job,bytes,job.video_path.endsWith('.webm')?'video/webm':'video/mp4');
    const saved=await sb.from('video_scan_jobs').update({status:'ready',result:analyzed.result,
      model_name:analyzed.model,input_tokens:analyzed.input,output_tokens:analyzed.output,
      search_queries:analyzed.queries,estimated_cost_usd:analyzed.estimatedCost,reserved_usd:0,
      updated_at:new Date().toISOString()}).eq('id',id);
    if(saved.error)throw saved.error;
  }catch(error){
    if(job)await sb.from('video_scan_jobs').update({status:'failed',error:String(error.message||error).slice(0,500),
      reserved_usd:0,updated_at:new Date().toISOString()}).eq('id',job.id);
  }finally{
    if(job?.video_path)await sb.storage.from('video-scan-staging').remove([job.video_path]);
  }
  return {statusCode:200};
}
