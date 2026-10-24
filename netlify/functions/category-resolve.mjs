import { json, corsHeaders } from '../lib/server.mjs';
import { portalAdminFromEvent } from '../lib/portal-auth.mjs';
import { resolveUnitCategories } from '../lib/category-resolve.mjs';
import { wrapHandler, asNetlifyFunction } from '../lib/floor-log.mjs';

async function handle(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  try {
    const body = JSON.parse(event.body || '{}');
    const { storeId } = await portalAdminFromEvent(event, body.store_id);
    const sku = String(body.sku || '').trim();
    if (!sku) return json(400, { error: 'sku_required' });
    return json(200, { ok: true, ...await resolveUnitCategories(storeId, sku, { network: body.network !== false }) });
  } catch (error) { return json(error?.status || 500, { ok: false, error: String(error?.message || error) }); }
}

export const invoke = wrapHandler('category-resolve', handle);
export default asNetlifyFunction(invoke);
