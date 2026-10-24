import { json, requireEnv } from '../lib/server.mjs';
import { wrapHandler, asNetlifyFunction } from '../lib/floor-log.mjs';
import { STORE_DEFAULT } from '../lib/amazon.mjs';
import { backfillCategoryBatch } from '../lib/category-backfill.mjs';

async function handle(event) {
  if (event.httpMethod !== 'POST' || event.headers?.authorization !== `Bearer ${requireEnv('SUPABASE_SERVICE_ROLE')}`)
    return json(403, { error: 'forbidden' });
  const body = JSON.parse(event.body || '{}');
  try {
    return json(200, { ok: true, ...await backfillCategoryBatch(body.store_id || STORE_DEFAULT,
      { offset: Math.max(0, Number(body.offset) || 0), limit: Math.min(Math.max(Number(body.limit) || 20, 1), 50),
        skus: Array.isArray(body.skus) ? body.skus.slice(0, 50).map(String) : null }) });
  } catch (error) { return json(500, { ok: false, error: String(error?.message || error) }); }
}

export const invoke = wrapHandler('category-backfill-background', handle);
export default asNetlifyFunction(invoke);
