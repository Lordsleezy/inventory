import { serviceClient } from './server.mjs';
import { validateAmazonUnitCategory } from './amazon-category-validation.mjs';

/** Call immediately before any external channel write, including republish. */
export async function assertBundlePush(storeId, sku, channel, { intent = true } = {}) {
  let category = null;
  const amazonValidation = String(channel).toLowerCase() === 'amazon'
    ? await validateAmazonUnitCategory(storeId, String(sku)) : null;
  if (['ebay', 'amazon', 'tiktok', 'depop'].includes(String(channel).toLowerCase())) {
    const { error: categoryError } = await serviceClient().rpc('floor_category_pre_push', {
      p_store: storeId, p_sku: String(sku), p_channel: String(channel).toLowerCase(),
    });
    if (categoryError) throw new Error(categoryError.message);
    const { data, error } = await serviceClient().from('unit_channel_categories')
      .select('category_id,attributes,validated_version').eq('store_id', storeId)
      .eq('sku', String(sku)).eq('channel', String(channel).toLowerCase()).single();
    if (error) throw new Error(error.message);
    category = { ...data, native_attributes: amazonValidation?.attributes };
  }
  const { error } = await serviceClient().rpc(intent ? 'floor_bundle_begin_push' : 'floor_bundle_push_gate', {
    p_store: storeId,
    p_sku: String(sku),
    p_channel: String(channel).toLowerCase(),
  });
  if (error) throw new Error(error.message);
  return category;
}

export async function bundleMainSku(storeId, sku) {
  const { data, error } = await serviceClient().from('floor_bundles')
    .select('main_sku').eq('store_id', storeId).eq('sku', sku).eq('active', true).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.main_sku || null;
}
