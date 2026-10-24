import { json, corsHeaders, serviceClient } from '../lib/server.mjs';
import { portalAdminFromEvent } from '../lib/portal-auth.mjs';
import { normalizeGtin } from '../lib/gtin-normalize.mjs';
import { wrapHandler, asNetlifyFunction } from '../lib/floor-log.mjs';
import { validateAmazonUnitCategory } from '../lib/amazon-category-validation.mjs';

async function handle(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'post_only' });
  try {
    const body = JSON.parse(event.body || '{}');
    const { storeId } = await portalAdminFromEvent(event, body.store_id);
    const sku = String(body.sku || '').trim();
    const sb = serviceClient();
    const { data: unit, error } = await sb.from('units').select('sku,upc,internal_category').eq('store_id', storeId).eq('sku', sku).single();
    if (error) throw new Error(error.message);
    await validateAmazonUnitCategory(storeId, sku);
    const gtin = normalizeGtin(unit.upc);
    if (!gtin.ok) return json(200, { ok: true, cached: false, reason: 'no_valid_upc' });
    const { data: gaps, error: gapError } = await sb.rpc('floor_category_gaps', { p_store: storeId, p_sku: sku, p_channel: null });
    if (gapError) throw new Error(gapError.message);
    if (gaps?.length) return json(200, { ok: true, cached: false, reason: 'category_gaps', gaps });
    const { data: rows, error: rowsError } = await sb.from('unit_channel_categories').select('channel,category_id,enabled,attributes')
      .eq('store_id', storeId).eq('sku', sku);
    if (rowsError) throw new Error(rowsError.message);
    const channels = Object.fromEntries((rows || []).map((row) => [row.channel, row]));
    if (!rows?.some((row) => row.enabled) || rows.some((row) => row.enabled && !row.category_id))
      return json(200, { ok: true, cached: false, reason: 'incomplete_mapping' });
    const { data: prior } = await sb.from('store_upc_categories').select('amazon_listing_id')
      .eq('store_id', storeId).eq('gtin14', gtin.gtin14).maybeSingle();
    const { error: saveError } = await sb.from('store_upc_categories').upsert({ store_id: storeId, gtin14: gtin.gtin14,
      ebay_category_id: channels.ebay?.category_id || null, amazon_product_type: channels.amazon?.category_id || null,
      tiktok_category_id: channels.tiktok?.category_id || null, depop_category_id: channels.depop?.category_id || null,
      channel_attributes: Object.fromEntries(rows.map((row) => [row.channel, row.attributes || {}])),
      amazon_listing_id: prior?.amazon_listing_id || null,
      internal_category: unit.internal_category || null, confirmed_at: new Date().toISOString() }, { onConflict: 'store_id,gtin14' });
    if (saveError) throw new Error(saveError.message);
    return json(200, { ok: true, cached: true, gtin14: gtin.gtin14 });
  } catch (error) { return json(error?.status || 500, { ok: false, error: String(error?.message || error) }); }
}

export const invoke = wrapHandler('category-confirm', handle);
export default asNetlifyFunction(invoke);
