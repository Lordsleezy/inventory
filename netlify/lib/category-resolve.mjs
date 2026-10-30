import { serviceClient } from './server.mjs';
import { normalizeGtin } from './gtin-normalize.mjs';
import { catalogItemByIdentifier } from './amazon.mjs';
import { ebayCategoriesForGtin, suggestCategories } from './ebay-catalog.mjs';
import { tiktokApiFetch } from './tiktok-shop.mjs';
import { refreshChannelCategoryFields } from './category-taxonomy.mjs';
import { validateAmazonUnitCategory } from './amazon-category-validation.mjs';
import { pickCategorySuggestion } from './ebay-aspects.mjs';

const CHANNELS = ['ebay', 'amazon', 'tiktok', 'depop'];

async function bestEbayCategory(unit, gtin) {
  let votes = [];
  if (gtin?.ok) {
    try { votes = await ebayCategoriesForGtin(gtin.upcA || gtin.ean13 || gtin.gtin14); }
    catch { /* Some seller apps lack Browse API access. Suggestion remains available. */ }
  }
  if (votes.length) {
    const total = votes.reduce((sum, row) => sum + row.count, 0);
    if (votes[0].count > total / 2 && (votes[0].count > votes[1]?.count || votes.length === 1))
      return { id: votes[0].categoryId, source: 'ebay_upc_majority', conflict: false };
    return { id: null, source: 'ebay_upc', conflict: true };
  }
  const query = [unit.brand, unit.model, unit.title].filter(Boolean).join(' ');
  if (!query) return { id: null, source: 'ebay_suggestion', conflict: false };
  const suggestions = await suggestCategories(query).catch(() => []);
  return { id: pickCategorySuggestion(suggestions, [unit.brand, unit.model, unit.title, unit.category])?.categoryId || null, source: 'ebay_title_suggestion', conflict: false };
}

async function recommendedTiktok(storeId, unit) {
  try {
    const json = await tiktokApiFetch(storeId, 'POST', '/product/202309/categories/recommend',
      { product_title: String(unit.title || [unit.brand, unit.model].filter(Boolean).join(' ')) },
      { category_version: 'v2', shop_cipher: process.env.TIKTOK_SHOP_SHOP_CIPHER || undefined });
    if (json?.code !== 0) return null;
    const list = json?.data?.categories || json?.data?.recommended_categories || [];
    return list.length === 1 ? String(list[0].id || list[0].category_id || '') || null : null;
  } catch { return null; }
}

async function categoryRows(sb, ids) {
  const valid = Object.entries(ids).filter(([channel, id]) => channel !== 'depop' && id);
  if (!valid.length) return new Map();
  const { data, error } = await sb.from('channel_taxonomy').select('channel,category_id,active,leaf,required_fields,fields_fetched_at,fingerprint,fields_version,validation_schema')
    .in('category_id', [...new Set(valid.map(([, id]) => id))]);
  if (error) throw new Error(error.message);
  return new Map((data || []).map((row) => [`${row.channel}:${row.category_id}`, row]));
}

function supportedAttributes(defs, product, unit) {
  const known = { Brand: unit.brand || product?.brand, brand: unit.brand || product?.brand,
    Model: unit.model || product?.model, model_number: unit.model || product?.model,
    MPN: unit.model || product?.model, UPC: unit.upc,
    item_name: unit.title || product?.title, merchant_suggested_asin: unit.listing_specs?.asin || product?.asin };
  const sources = [known, product?.aspects || {}, unit.listing_specs?.amazon_aspects || {},
    unit.listing_specs?.ebay_aspects || {}, unit.ebay_item_specifics || {}];
  const values = {};
  for (const def of defs || []) {
    const candidate = sources.map((source) => source[def.name] || source[def.label])
      .flatMap((value) => Array.isArray(value) ? value : [value]).find((value) => value != null && String(value).trim());
    if (candidate == null) continue;
    const text = String(candidate).trim();
    if (def.allowed?.length && !def.allowed.includes(text)) continue;
    values[def.name] = text;
  }
  return values;
}

/** Resolve a single unit. Confirmed UPC mappings win; uncertain and conflicting results remain in Missing Category. */
export async function resolveUnitCategories(storeId, sku, { network = true } = {}) {
  const sb = serviceClient();
  const { data: unit, error: unitError } = await sb.from('units').select('*').eq('store_id', storeId).eq('sku', sku).single();
  if (unitError) throw new Error(unitError.message);
  const gtin = normalizeGtin(unit.upc);
  const [{ data: cached }, { data: product }] = await Promise.all([
    gtin.ok ? sb.from('store_upc_categories').select('*').eq('store_id', storeId).eq('gtin14', gtin.gtin14).maybeSingle() : Promise.resolve({ data: null }),
    gtin.ok ? sb.from('floor_products').select('*').eq('gtin14', gtin.gtin14).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const ids = { ebay: cached?.ebay_category_id || null, amazon: cached?.amazon_product_type || null,
    tiktok: cached?.tiktok_category_id || null, depop: cached?.depop_category_id || null };
  const sources = {};
  let productData = product;
  let conflict = false;
  let amazonListingId = cached?.amazon_listing_id || null;
  if (!cached && product?.category) {
    const { data: mapped } = await sb.from('store_category_mappings').select('*')
      .eq('store_id', storeId).eq('internal_category', product.category).limit(2);
    if (mapped?.length === 1) {
      ids.ebay = mapped[0].ebay_category_id;
      ids.tiktok = mapped[0].tiktok_category_id;
      ids.depop = mapped[0].depop_category_id;
      ids.amazon = mapped[0].amazon_product_type;
      sources.ebay = 'floor_upc_mapping';
    } else if (mapped?.length > 1) conflict = true;
  }
  if (!ids.ebay) {
    const explicit = String(unit.listing_specs?.ebay_category_id || unit.ebay_category || '');
    if (/^\d+$/.test(explicit)) { ids.ebay = explicit; sources.ebay = 'existing_unit'; }
  }
  if (network && gtin.ok && (!cached || !ids.amazon)) {
    const amazon = await catalogItemByIdentifier(storeId, gtin.upcA ? 'UPC' : 'GTIN', gtin.upcA || gtin.gtin14)
      .catch(() => ({ found: false }));
    if (amazon.found && amazon.item?.product_type) {
      productData = { ...amazon.item, ...(product || {}), aspects: { ...(amazon.item.aspects || {}), ...(product?.aspects || {}) } };
      if (amazon.alternatives?.length) conflict = true;
      if (ids.amazon && ids.amazon !== amazon.item.product_type) conflict = true;
      else ids.amazon = amazon.item.product_type;
      sources.amazon = 'amazon_catalog';
      const { data: matched } = await sb.from('amazon_list_items').select('asin,status')
        .eq('store_id', storeId).eq('sku', sku).eq('status', 'live').maybeSingle();
      if (matched?.asin === amazon.item.asin) amazonListingId = matched.asin;
    }
  }
  if (network && (!cached || !ids.ebay)) {
    const ebay = await bestEbayCategory(unit, gtin);
    if (ebay.conflict) conflict = true;
    if (ebay.id) {
      if (ids.ebay && ids.ebay !== ebay.id) conflict = true;
      else ids.ebay = ebay.id;
      sources.ebay = ebay.source;
    }
  }
  if (ids.ebay) {
    const { data: mapping } = await sb.from('store_category_mappings').select('*')
      .eq('store_id', storeId).eq('ebay_category_id', ids.ebay).maybeSingle();
    if (mapping) {
      for (const [channel, field] of [['amazon', 'amazon_product_type'], ['tiktok', 'tiktok_category_id'], ['depop', 'depop_category_id']]) {
        if (ids[channel] && mapping[field] && ids[channel] !== mapping[field]) conflict = true;
        else if (!ids[channel]) ids[channel] = mapping[field] || null;
      }
    }
  }
  if (!ids.tiktok && network) {
    ids.tiktok = await recommendedTiktok(storeId, unit);
    if (ids.tiktok) sources.tiktok = 'tiktok_recommendation';
  }
  let tax = await categoryRows(sb, ids);
  if (network) {
    for (const [channel, id] of Object.entries(ids)) {
      const row = tax.get(`${channel}:${id}`);
      if (channel === 'depop' || !row?.active || !row.leaf) continue;
      if (!row.fields_fetched_at || (channel === 'amazon' && !row.validation_schema)
        || Date.parse(row.fields_fetched_at) < Date.now() - 3 * 86400000) {
        await refreshChannelCategoryFields(channel, storeId, id).catch(() => {});
      }
    }
    tax = await categoryRows(sb, ids);
  }
  const { data: existing } = await sb.from('unit_channel_categories').select('channel,category_id,enabled,attributes,adopted_live,source')
    .eq('store_id', storeId).eq('sku', sku);
  const current = new Map((existing || []).map((row) => [row.channel, row]));
  const updates = [];
  for (const channel of CHANNELS) {
    const prior = current.get(channel);
    if (prior?.adopted_live || prior?.source === 'manual') continue;
    const id = ids[channel];
    const row = tax.get(`${channel}:${id}`);
    const valid = channel === 'depop' ? Boolean(id) : Boolean(row?.active && row?.leaf && row?.fields_fetched_at);
    const attributes = channel === 'depop' ? { ...(cached?.channel_attributes?.[channel] || {}), ...(prior?.attributes || {}) }
      : { ...(cached?.channel_attributes?.[channel] || {}), ...(prior?.attributes || {}),
      ...supportedAttributes(row?.required_fields, productData, unit) };
    updates.push({ store_id: storeId, sku, channel, category_id: id || prior?.category_id || null,
      enabled: prior?.enabled ?? channel !== 'depop', attributes,
      source: sources[channel] || (cached ? 'confirmed_upc' : 'auto'),
      validated_version: valid && row ? `${row.fingerprint || ''}:${row.fields_version || ''}` : null,
      review_reason: conflict ? 'conflicting category sources' : valid ? null : 'missing category or unsynced fields',
      updated_at: new Date().toISOString() });
  }
  if (updates.length) {
    const { error } = await sb.from('unit_channel_categories').upsert(updates, { onConflict: 'store_id,sku,channel' });
    if (error) throw new Error(error.message);
  }
  await validateAmazonUnitCategory(storeId, sku);
  const { data: gaps, error: gapError } = await sb.rpc('floor_category_gaps', { p_store: storeId, p_sku: sku, p_channel: null });
  if (gapError) throw new Error(gapError.message);
  const enabledChannels = CHANNELS.filter((channel) => current.get(channel)?.enabled);
  const finalIds = Object.fromEntries(CHANNELS.map((channel) => [channel,
    updates.find((row) => row.channel === channel)?.category_id || current.get(channel)?.category_id || null]));
  const confirmed = !conflict && !gaps?.length && enabledChannels.length > 0 &&
    enabledChannels.every((channel) => Boolean(finalIds[channel]));
  if (gtin.ok && confirmed) {
    const { error } = await sb.from('store_upc_categories').upsert({ store_id: storeId, gtin14: gtin.gtin14,
      ebay_category_id: finalIds.ebay, amazon_product_type: finalIds.amazon, amazon_listing_id: amazonListingId,
      tiktok_category_id: finalIds.tiktok, depop_category_id: finalIds.depop, internal_category: product?.category || unit.internal_category || null,
      channel_attributes: Object.fromEntries(CHANNELS.map((channel) => [channel,
        updates.find((row) => row.channel === channel)?.attributes || current.get(channel)?.attributes || {}])),
      confirmed_at: new Date().toISOString() }, { onConflict: 'store_id,gtin14' });
    if (error) throw new Error(error.message);
    if (finalIds.ebay) {
      const { error: mappingError } = await sb.from('store_category_mappings').upsert({ store_id: storeId, ebay_category_id: finalIds.ebay },
        { onConflict: 'store_id,ebay_category_id', ignoreDuplicates: true });
      if (mappingError) throw new Error(mappingError.message);
      for (const [field, value] of Object.entries({ amazon_product_type: finalIds.amazon,
        tiktok_category_id: finalIds.tiktok, depop_category_id: finalIds.depop,
        internal_category: product?.category || unit.internal_category || null })) {
        if (!value) continue;
        const { error: fillError } = await sb.from('store_category_mappings').update({ [field]: value })
          .eq('store_id', storeId).eq('ebay_category_id', finalIds.ebay).is(field, null);
        if (fillError) throw new Error(fillError.message);
      }
    }
  }
  return { sku, categories: finalIds, sources, conflict, confirmed: Boolean(confirmed), gaps };
}
