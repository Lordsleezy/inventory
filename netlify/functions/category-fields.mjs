import { json, corsHeaders } from '../lib/server.mjs';
import { portalAdminFromEvent } from '../lib/portal-auth.mjs';
import { refreshChannelCategoryFields } from '../lib/category-taxonomy.mjs';
import { wrapHandler, asNetlifyFunction } from '../lib/floor-log.mjs';

async function handle(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  try {
    const body = JSON.parse(event.body || '{}');
    const { storeId } = await portalAdminFromEvent(event, body.store_id);
    const channel = String(body.channel || '');
    const categoryId = String(body.category_id || '');
    if (!['ebay', 'amazon', 'tiktok'].includes(channel) || !categoryId) return json(400, { error: 'invalid_category' });
    const fields = await refreshChannelCategoryFields(channel, storeId, categoryId);
    return json(200, { ok: true, fields });
  } catch (error) { return json(error?.status || 500, { ok: false, error: String(error?.message || error) }); }
}

export const invoke = wrapHandler('category-fields', handle);
export default asNetlifyFunction(invoke);
