import { serviceClient, json, corsHeaders } from '../lib/server.mjs';

export async function handler(event) {
  if(event.httpMethod==='OPTIONS')return {statusCode:204,headers:corsHeaders(),body:''};
  if(event.httpMethod!=='POST')return json(405,{error:'POST required'});
  try {
    const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
    const id=JSON.parse(event.body||'{}').id;
    if(!token||!/^[0-9a-f-]{36}$/i.test(String(id)))return json(400,{error:'Invalid scan request'});
    const sb=serviceClient();
    const auth=await sb.auth.getUser(token);
    if(auth.error||!auth.data.user)return json(401,{error:'Sign in required'});
    const found=await sb.from('video_scan_jobs').select('created_by,status,video_path').eq('id',id).single();
    if(found.error||found.data.created_by!==auth.data.user.id||found.data.status!=='saved')return json(404,{error:'Saved scan not found'});
    const file=await sb.storage.from('video-scan-staging').info(found.data.video_path);
    if(file.error)return json(409,{error:'Video upload still in progress'});
    const response=await fetch(`${process.env.URL||'https://inventoryobi.netlify.app'}/.netlify/functions/video-scan-enrich-background`,{
      method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({id})});
    if(!response.ok)throw new Error(`Background enrichment could not start (${response.status})`);
    return json(202,{ok:true});
  } catch(error) {return json(500,{error:error.message||String(error)})}
}
