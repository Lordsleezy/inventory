import { serviceClient } from './server.mjs';
import { inspectLiveSku } from './ebay.mjs';
import { spapiFetch, marketplaceId } from './amazon.mjs';
import { tiktokApiFetch } from './tiktok-shop.mjs';
import { resolveUnitCategories } from './category-resolve.mjs';
import { resolveEbayAccount, userTokenForAccount } from './ebay-accounts.mjs';
import { getTradingItem } from './ebay-trading.mjs';

const sellerId = () => String(process.env.AMAZON_SELLER_ID || '').trim();

async function adoptLive(storeId, sku, channel, categoryId, attributes = {}) {
  if (!categoryId) return false;
  const sb = serviceClient();
  const { data: prior } = await sb.from('unit_channel_categories').select('category_id,attributes,adopted_live')
    .eq('store_id', storeId).eq('sku', sku).eq('channel', channel).maybeSingle();
  if (prior?.adopted_live && prior.category_id === String(categoryId)) return false;
  const { data: taxonomy } = channel === 'depop' ? { data: null } : await sb.from('channel_taxonomy')
    .select('fingerprint,fields_version').eq('channel', channel).eq('category_id', String(categoryId)).maybeSingle();
  const { error } = await sb.from('unit_channel_categories').upsert({ store_id: storeId, sku, channel,
    category_id: String(categoryId), enabled: true, adopted_live: true, source: 'live_listing',
    attributes: { ...(prior?.category_id === String(categoryId) ? prior.attributes || {} : {}), ...attributes },
    validated_version: taxonomy ? `${taxonomy.fingerprint || ''}:${taxonomy.fields_version || ''}` : null,
    review_reason: null, updated_at: new Date().toISOString() }, { onConflict: 'store_id,sku,channel' });
  if (error) throw new Error(error.message);
  if (channel === 'ebay') {
    const { error: mapError } = await sb.from('store_category_mappings').upsert({ store_id: storeId,
      ebay_category_id: String(categoryId) }, { onConflict: 'store_id,ebay_category_id', ignoreDuplicates: true });
    if (mapError) throw new Error(mapError.message);
  }
  return true;
}

async function adoptListingCategories(storeId, unit) {
  const sb = serviceClient();
  const sku = unit.sku;
  const { data: listings } = await sb.from('listings').select('channel,listing_id,status')
    .eq('store_id', storeId).eq('sku', sku).eq('status', 'listed');
  const liveRows = [...(listings || [])];
  if (!liveRows.some((x) => x.channel === 'amazon')) {
    const { data: a } = await sb.from('amazon_list_items').select('listing_sku,status').eq('store_id', storeId).eq('sku', sku).eq('status', 'live').maybeSingle();
    if (a) liveRows.push({ channel: 'amazon', listing_id: a.listing_sku || sku, status: 'listed' });
  }
  if (!liveRows.some((x) => x.channel === 'tiktok')) {
    const { data: t } = await sb.from('tiktok_list_items').select('product_id,status').eq('store_id', storeId).eq('sku', sku).eq('status', 'live').maybeSingle();
    if (t) liveRows.push({ channel: 'tiktok', listing_id: t.product_id, status: 'listed' });
  }
  let adopted = 0;
  const failures = [];
  for (const listing of liveRows) {
    if (!['ebay', 'amazon', 'tiktok', 'depop'].includes(listing.channel)) continue;
    try {
      let id = null;
      let attributes = {};
      if (listing.channel === 'ebay') {
        let live = await inspectLiveSku(storeId, sku);
        if (!live.categoryId && listing.listing_id) {
          const account = await resolveEbayAccount(storeId, { role: 'selling' });
          const token = await userTokenForAccount(account);
          live = await getTradingItem(token, listing.listing_id);
        }
        id = live.categoryId;
        attributes = Object.fromEntries(Object.entries(live.aspects || live.specifics || {}).map(([key, value]) =>
          [key, Array.isArray(value) ? String(value[0] || '') : String(value)]));
      }
      if (listing.channel === 'amazon' && sellerId()) {
        const { data: amazonLink } = await sb.from('amazon_list_items').select('listing_sku,offer_sku')
          .eq('store_id', storeId).eq('sku', sku).maybeSingle();
        const sellerSku = amazonLink?.listing_sku || amazonLink?.offer_sku || sku;
        const row = await spapiFetch(storeId, 'GET', `/listings/2021-08-01/items/${encodeURIComponent(sellerId())}/${encodeURIComponent(sellerSku)}` +
          `?marketplaceIds=${marketplaceId()}&includedData=summaries`);
        id = row.summaries?.[0]?.productType || row.productType || null;
      }
      if (listing.channel === 'tiktok') {
        const { data: linked } = await sb.from('tiktok_list_items').select('product_id').eq('store_id', storeId).eq('sku', sku).maybeSingle();
        if (linked?.product_id) {
          const response = await tiktokApiFetch(storeId, 'GET', `/product/202309/products/${encodeURIComponent(linked.product_id)}`,
            null, { shop_cipher: process.env.TIKTOK_SHOP_SHOP_CIPHER || undefined });
          if (response?.code === 0) id = response?.data?.product?.category_id || response?.data?.category_id;
        }
      }
      if (id) {
        if (await adoptLive(storeId, sku, listing.channel, id, attributes)) adopted++;
      } else failures.push(`${listing.channel}:category_unavailable`);
    } catch (error) { failures.push(`${listing.channel}:${String(error?.message || error).slice(0, 120)}`); }
  }
  return { adopted, failures, live: liveRows.length > 0 };
}

/** One bounded batch; a caller can repeat offset until processed is zero. */
export async function backfillCategoryBatch(storeId, { offset = 0, limit = 20, network = true, skus = null } = {}) {
  const sb = serviceClient();
  let query = sb.from('units').select('sku,upc,state,listing_specs')
    .eq('store_id', storeId).in('state', ['available', 'reserved', 'repair'])
    .order('sku');
  query = Array.isArray(skus) ? query.in('sku', skus.slice(0, 50).map(String))
    : query.range(offset, offset + Math.min(Math.max(limit, 1), 50) - 1);
  const { data: units, error } = await query;
  if (error) throw new Error(error.message);
  const stats = { processed: 0, auto_resolved: 0, needs_owner: 0, live_adopted: 0, moved_not_ready: 0, failures: [] };
  for (const unit of units || []) {
    try {
      const live = await adoptListingCategories(storeId, unit);
      stats.live_adopted += live.adopted;
      const result = await resolveUnitCategories(storeId, unit.sku, { network });
      const { error: demoteError } = await sb.rpc('floor_category_demote_sku', { p_store: storeId, p_sku: unit.sku });
      if (demoteError) throw new Error(demoteError.message);
      const { data: after } = await sb.from('units').select('listing_specs').eq('store_id', storeId).eq('sku', unit.sku).single();
      if (unit.listing_specs?.ready_to_list && !after?.listing_specs?.ready_to_list) stats.moved_not_ready++;
      if (result.gaps?.length || result.conflict || live.failures.length) stats.needs_owner++;
      else stats.auto_resolved++;
      stats.processed++;
      for (const problem of live.failures) stats.failures.push({ sku: unit.sku, error: problem });
    } catch (failure) { stats.failures.push({ sku: unit.sku, error: String(failure?.message || failure).slice(0, 200) }); }
  }
  const { error: logError } = await sb.from('category_backfill_runs').insert({ store_id: storeId, offset_started: offset,
    ...stats, failures: stats.failures.slice(0, 100) });
  if (logError) throw new Error(logError.message);
  return { ...stats, next_offset: offset + (units || []).length };
}
