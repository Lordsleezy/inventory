import { createHmac, timingSafeEqual } from 'node:crypto';
import { requireEnv, serviceClient } from './server.mjs';

// A short-lived signature lets an authorized foreground request hand work to a
// Netlify background function without depending on the phone session afterward.
export function scanWorkerHeader(id) {
  const at = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', requireEnv('SUPABASE_SERVICE_ROLE'))
    .update(`${id}:${at}`).digest('hex');
  return `${at}.${signature}`;
}

export function validWorkerHeader(event, id) {
  const raw = event.headers['x-floor-scan-worker'] || event.headers['X-Floor-Scan-Worker'] || '';
  const match = /^(\d{10})\.([0-9a-f]{64})$/i.exec(raw);
  if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 300) return false;
  const expected = createHmac('sha256', requireEnv('SUPABASE_SERVICE_ROLE'))
    .update(`${id}:${match[1]}`).digest();
  return timingSafeEqual(Buffer.from(match[2], 'hex'), expected);
}

export async function authorizedScan(event,id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('Invalid scan request');
  if (validWorkerHeader(event, id)) {
    const sb = serviceClient();
    const found = await sb.from('video_scan_jobs').select('*').eq('id', id).single();
    if (found.error || !found.data) throw new Error('Scan not found');
    return { sb, job: found.data, token: null };
  }
  const token=(event.headers.authorization||event.headers.Authorization||'').replace(/^Bearer\s+/i,'');
  if(!token)throw new Error('Sign in required');
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
