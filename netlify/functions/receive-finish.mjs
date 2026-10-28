import { json, corsHeaders, requireEnv } from '../lib/server.mjs';
import { receiveAccessFromEvent } from '../lib/receive-auth.mjs';
import { wrapHandler, asNetlifyFunction } from '../lib/floor-log.mjs';
async function handle(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  try {
    const { storeId } = await receiveAccessFromEvent(event);
    const base = (process.env.URL || 'https://inventoryobi.netlify.app').replace(/\/$/, '');
    const response = await fetch(`${base}/.netlify/functions/receive-finish-background`, { method: 'POST',
      headers: { Authorization: `Bearer ${requireEnv('SUPABASE_SERVICE_ROLE')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ storeId }) });
    if (!response.ok) throw new Error('Background dispatch unavailable; saved work will retry on the existing schedule');
    return json(202, { ok: true });
  } catch (error) { return json(error.status || 500, { error: String(error.message || error) }); }
}
export const invoke = wrapHandler('receive-finish', handle);
export default asNetlifyFunction(invoke);
