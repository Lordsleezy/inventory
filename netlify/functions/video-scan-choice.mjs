import { serviceClient, json, corsHeaders } from '../lib/server.mjs';

export async function handler(event) {
  if(event.httpMethod==='OPTIONS')return {statusCode:204,headers:corsHeaders(),body:''};
  if(event.httpMethod!=='POST')return json(405,{error:'POST required'});
  try {
    const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
    const {id,index}=JSON.parse(event.body||'{}');
    if(!token||!/^[0-9a-f-]{36}$/i.test(String(id))||!Number.isInteger(index))
      return json(400,{error:'Invalid choice'});
    const sb=serviceClient(),auth=await sb.auth.getUser(token);
    if(auth.error||!auth.data.user)return json(401,{error:'Sign in required'});
    const found=await sb.from('video_scan_jobs').select('created_by,status,result').eq('id',id).single();
    if(found.error||found.data.created_by!==auth.data.user.id||found.data.status!=='ready')
      return json(404,{error:'Ready scan not found'});
    const selected=found.data.result?.options?.[index];
    if(!selected)return json(400,{error:'Choice not found'});
    const result={...found.data.result,...selected,options:[],selected_option:true,retail_ready:false};
    delete result.thumbnail_data_url;
    const updated=await sb.from('video_scan_jobs').update({result}).eq('id',id).eq('status','ready');
    if(updated.error)throw updated.error;
    const url=`${process.env.URL||'https://inventoryobi.netlify.app'}/.netlify/functions/video-scan-background`;
    const started=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({id,mode:'price'})});
    if(!started.ok)throw new Error(`Retail lookup could not start (${started.status})`);
    return json(202,{ok:true});
  }catch(error){return json(500,{error:error.message||String(error)})}
}
