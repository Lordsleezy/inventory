import { serviceClient } from './server.mjs';
import { portalAdminFromEvent } from './portal-auth.mjs';

/** Receive lookup endpoints are available to admins and active store staff. */
export async function receiveAccessFromEvent(event, storeIdHint, {
  adminAuth = portalAdminFromEvent, getServiceClient = serviceClient,
} = {}) {
  try {
    return { ...(await adminAuth(event, storeIdHint)), isAdmin: true };
  } catch (adminError) {
    if (adminError?.status && adminError.status !== 403) throw adminError;
  }

  const token = (event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) throw Object.assign(new Error('Sign in required'), { status: 401 });
  const sb = getServiceClient();
  const { data: auth, error: authError } = await sb.auth.getUser(token);
  if (authError || !auth?.user) throw Object.assign(new Error('Sign in required'), { status: 401 });

  let staffQuery = sb.from('staff').select('store_id')
    .eq('user_id', auth.user.id).is('deactivated_at', null);
  if (storeIdHint) staffQuery = staffQuery.eq('store_id', storeIdHint);
  const { data: staff, error: staffError } = await staffQuery.maybeSingle();
  if (staffError) throw Object.assign(new Error('Staff access could not be checked'), { status: 503 });
  if (!staff?.store_id) throw Object.assign(new Error('Staff access required'), { status: 403 });
  return { sb, storeId: staff.store_id, actor: auth.user.email || auth.user.id,
    userId: auth.user.id, isAdmin: false };
}

/** A staff member may confirm catalog details only for units they received. */
export async function staffOwnsReceivedSkus(ctx, skus) {
  if (ctx.isAdmin) return true;
  if (!ctx.userId || !skus.length) return false;
  const { data, error } = await ctx.sb.from('events').select('sku')
    .eq('store_id', ctx.storeId).eq('actor_id', ctx.userId)
    .eq('kind', 'received').in('sku', skus);
  if (error) throw Object.assign(new Error('Could not verify received units'), { status: 503 });
  return new Set((data || []).map(row => row.sku)).size === new Set(skus).size;
}
