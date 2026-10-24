import { json, corsHeaders, requireEnv } from '../lib/server.mjs';
import { portalAdminFromEvent } from '../lib/portal-auth.mjs';
import { wrapHandler, asNetlifyFunction } from '../lib/floor-log.mjs';
import { STORE_DEFAULT } from '../lib/amazon.mjs';

async function handle(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  try {
    const body = JSON.parse(event.body || '{}');
    const { storeId } = await portalAdminFromEvent(event, body.store_id || STORE_DEFAULT);
    const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
    const base = (process.env.URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');
    const response = await fetch(`${base}/.netlify/functions/category-backfill-background`, { method: 'POST',
      headers: { Authorization: `Bearer ${requireEnv('SUPABASE_SERVICE_ROLE')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: storeId, offset, limit: Math.min(Math.max(Number(body.limit) || 20, 1), 50),
        skus: Array.isArray(body.skus) ? body.skus.slice(0, 50).map(String) : null }) });
    return json(response.ok ? 202 : 502, { queued: response.ok, offset, status: response.status });
  } catch (error) { return json(error?.status || 500, { error: String(error?.message || error) }); }
}

export const invoke = wrapHandler('category-backfill', handle);
export default asNetlifyFunction(invoke);
