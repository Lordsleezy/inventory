import { serviceClient } from './server.mjs';

/** Call immediately before any external channel write, including republish. */
export async function assertBundlePush(storeId, sku, channel, { intent = true } = {}) {
  const { error } = await serviceClient().rpc(intent ? 'floor_bundle_begin_push' : 'floor_bundle_push_gate', {
    p_store: storeId,
    p_sku: String(sku),
    p_channel: String(channel).toLowerCase(),
  });
  if (error) throw new Error(error.message);
}

export async function bundleMainSku(storeId, sku) {
  const { data, error } = await serviceClient().from('floor_bundles')
    .select('main_sku').eq('store_id', storeId).eq('sku', sku).eq('active', true).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.main_sku || null;
}
