import { serviceClient } from './server.mjs';

export async function authorizedScan(event,id) {
  const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
  if(!token||!/^[0-9a-f-]{36}$/i.test(String(id)))throw new Error('Invalid scan request');
  const sb=serviceClient(),auth=await sb.auth.getUser(token);
  if(auth.error||!auth.data.user)throw new Error('Sign in required');
  const found=await sb.from('video_scan_jobs').select('*').eq('id',id).single();
  if(found.error||!found.data)throw new Error('Scan not found');
  if(found.data.created_by!==auth.data.user.id){
    const admin=await sb.from('portal_admins').select('user_id').eq('user_id',auth.data.user.id)
      .eq('store_id',found.data.store_id).maybeSingle();
    if(admin.error||!admin.data)throw new Error('Scan not found');
  }
  return {sb,job:found.data,token};
}
