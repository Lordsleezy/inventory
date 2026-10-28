import { json, serviceClient, requireEnv } from '../lib/server.mjs';
import { drainReceiveJobs } from '../lib/receive-jobs.mjs';
import { wrapHandler, asNetlifyFunction } from '../lib/floor-log.mjs';

async function handle(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  try {
    if ((event.headers?.authorization || event.headers?.Authorization) !== `Bearer ${requireEnv('SUPABASE_SERVICE_ROLE')}`) return json(403, { error: 'receive_access_denied' });
    const { storeId, scheduled } = JSON.parse(event.body || '{}');
    if (!storeId && !scheduled) return json(400, { error: 'store_required' });
    // No caller-supplied SKU, fields or choices: drain only already committed work.
    await drainReceiveJobs({ sb: serviceClient(), storeId, limit: 2 });
    return json(202, { ok: true });
  } catch (error) { return json(error.status || 500, { error: String(error.message || error) }); }
}
export const invoke = wrapHandler('receive-finish-background', handle);
export default asNetlifyFunction(invoke);
