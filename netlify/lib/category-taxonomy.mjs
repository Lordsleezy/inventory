import { createHash } from "node:crypto";
import { serviceClient } from "./server.mjs";
import { fetchCategoryTree, fetchLiveAspects } from "./ebay-catalog.mjs";
import { marketplaceId, spapiFetch } from "./amazon.mjs";
import { tiktokApiFetch } from "./tiktok-shop.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const chunks = (rows, size = 300) => Array.from({ length: Math.ceil(rows.length / size) }, (_, n) => rows.slice(n * size, (n + 1) * size));
async function retryLimited(call) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await call(); }
    catch (error) {
      if (attempt === 3 || !/429|quota|rate.?limit|503|throttl/i.test(String(error?.message || error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (2 ** attempt)));
    }
  }
}

function ebayRows(root) {
  const rows = [];
  function walk(node, parentId = null, ancestors = []) {
    const id = String(node?.category?.categoryId || "");
    if (!id) return;
    const name = String(node.category.categoryName || id);
    const path = [...ancestors, name];
    rows.push({ category_id: id, parent_id: parentId, path: path.join(" > "), leaf: Boolean(node.leafCategoryTreeNode) });
    for (const child of node.childCategoryTreeNodes || []) walk(child, id, path);
  }
  walk(root);
  return rows;
}

function flatRows(rows, idKey, nameKey, leafKey) {
  const byId = new Map(rows.map((row) => [String(row[idKey]), row]));
  function path(row) {
    const seen = new Set();
    const names = [];
    let node = row;
    while (node && !seen.has(String(node[idKey]))) {
      seen.add(String(node[idKey]));
      names.unshift(String(node[nameKey] || node[idKey]));
      node = byId.get(String(node.parent_id));
    }
    return names.join(" > ");
  }
  return rows.map((row) => ({ category_id: String(row[idKey]), parent_id: row.parent_id ? String(row.parent_id) : null,
    path: path(row), leaf: Boolean(row[leafKey]),
    permissions: row.permission_statuses || [],
    active: !row.permission_statuses?.length || row.permission_statuses.includes('AVAILABLE') }));
}

async function upsertSnapshot(channel, storeId, version, rows) {
  if (!rows.length || rows.some((row) => !row.category_id || !row.path)) throw new Error(`${channel}_empty_or_invalid_tree`);
  const sb = serviceClient();
  const now = new Date().toISOString();
  for (const batch of chunks(rows)) {
    const ids = batch.map((row) => row.category_id);
    const { data: prior, error: readError } = await sb.from("channel_taxonomy")
      .select("category_id,fingerprint,required_fields,fields_fetched_at,fields_version,changed_at").eq("channel", channel).in("category_id", ids);
    if (readError) throw new Error(readError.message);
    const old = new Map((prior || []).map((row) => [row.category_id, row]));
    const payload = batch.map((row) => {
      row = { ...row, active: row.active !== false };
      const fingerprint = digest([row.parent_id, row.path, row.leaf, row.active, row.permissions || []]);
      const before = old.get(row.category_id);
      const same = before?.fingerprint === fingerprint;
      return { channel, ...row, version, fingerprint, fetched_at: now, retired_at: null,
        changed_at: same ? before.changed_at : now,
        fields_fetched_at: same ? before.fields_fetched_at : null,
        fields_version: same ? before.fields_version : null,
        required_fields: same ? before.required_fields : [] };
    });
    const { error } = await sb.from("channel_taxonomy").upsert(payload, { onConflict: "channel,category_id" });
    if (error) throw new Error(error.message);
  }
  const { error } = await sb.from("channel_taxonomy").update({ active: false, retired_at: now })
    .eq("channel", channel).neq("version", version).eq("active", true);
  if (error) throw new Error(error.message);
  return { channel, version, count: rows.length, storeId };
}

async function updateRequired(channel, categoryId, defs, validationSchema = null) {
  const sb = serviceClient();
  const fieldsVersion = digest([defs, validationSchema]);
  const { data: before } = await sb.from('channel_taxonomy').select('fields_version').eq('channel', channel).eq('category_id', categoryId).maybeSingle();
  const { error } = await sb.from("channel_taxonomy").update({ required_fields: defs, validation_schema: validationSchema, fields_version: fieldsVersion,
    fields_fetched_at: new Date().toISOString(),
    ...(before?.fields_version && before.fields_version !== fieldsVersion ? { changed_at: new Date().toISOString() } : {})
  }).eq("channel", channel).eq("category_id", categoryId);
  if (error) throw new Error(error.message);
}

export async function refreshChannelCategoryFields(channel, storeId, categoryId) {
  const sb = serviceClient();
  const { data: category, error: readError } = await sb.from('channel_taxonomy').select('active,leaf')
    .eq('channel', channel).eq('category_id', categoryId).maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!category?.active || !category.leaf) throw new Error('category_not_active_leaf');
  let defs;
  let validationSchema = null;
  if (channel === 'ebay') {
    const live = await retryLimited(() => fetchLiveAspects(categoryId));
    defs = live.filter((d) => d.required).map((d) => ({ name: d.name, required: true,
      allowed: d.selectionOnly ? d.allowed : [] }));
  } else if (channel === 'tiktok') {
    const attrs = await retryLimited(() => tiktokApiFetch(storeId, 'GET', `/product/202309/categories/${encodeURIComponent(categoryId)}/attributes`, null,
      { category_version: 'v2', shop_cipher: process.env.TIKTOK_SHOP_SHOP_CIPHER || undefined }));
    if (attrs?.code !== 0) throw new Error(attrs?.message || `tiktok_attributes_failed:${categoryId}`);
    defs = (attrs?.data?.attributes || []).filter((a) => a.is_required).map((a) => ({ name: String(a.id),
      label: String(a.name || a.id), required: true, allowed: (a.values || []).map((v) => String(v.id)),
      labels: Object.fromEntries((a.values || []).map((v) => [String(v.id), String(v.name || v.id)])) }));
    const rules = await retryLimited(() => tiktokApiFetch(storeId, 'GET', `/product/202309/categories/${encodeURIComponent(categoryId)}/rules`, null,
      { category_version: 'v2', shop_cipher: process.env.TIKTOK_SHOP_SHOP_CIPHER || undefined }));
    if (rules?.code !== 0) throw new Error(rules?.message || `tiktok_rules_failed:${categoryId}`);
    for (const cert of rules?.data?.product_certifications || []) if (cert.is_required) {
      defs.push({ name: `certification:${cert.id}`, label: cert.name || `Certification ${cert.id}`,
        required: true, allowed: [], kind: 'unsupported_document' });
    }
    if (rules?.data?.size_chart?.is_required) defs.push({ name: 'size_chart', label: 'Size chart',
      required: true, allowed: [], kind: 'unsupported_document' });
  } else if (channel === 'amazon') {
    const def = await retryLimited(() => spapiFetch(storeId, 'GET', `/definitions/2020-09-01/productTypes/${encodeURIComponent(categoryId)}` +
      `?marketplaceIds=${marketplaceId()}&requirements=LISTING_OFFER_ONLY&requirementsEnforced=ENFORCED` +
      (process.env.AMAZON_SELLER_ID ? `&sellerId=${encodeURIComponent(process.env.AMAZON_SELLER_ID)}` : '')));
    const schemaUrl = def.schema?.link?.resource;
    if (!schemaUrl) throw new Error(`amazon_definition_missing_schema:${categoryId}`);
    const response = await fetch(schemaUrl);
    if (!response.ok) throw new Error(`amazon_schema_${response.status}:${categoryId}`);
    const schema = await response.json();
    validationSchema = schema;
    defs = Object.entries(schema.properties || {}).map(([name, property]) => ({ name, label: property.title || name,
      required: (schema.required || []).includes(name),
      kind: property.items?.properties?.value ? 'value' : 'json',
      allowed: (property.items?.properties?.value?.enum || property.enum || []).map(String) }));
  } else throw new Error('invalid_channel');
  await updateRequired(channel, categoryId, defs, validationSchema);
  return defs;
}

async function usedCategoryIds(channel, storeId) {
  const { data, error } = await serviceClient().from("unit_channel_categories").select("category_id")
    .eq("store_id", storeId).eq("channel", channel).not("category_id", "is", null).limit(10000);
  if (error) throw new Error(error.message);
  const ids = [...new Set((data || []).map((x) => x.category_id).filter(Boolean))];
  if (!ids.length) return [];
  const { data: active, error: activeError } = await serviceClient().from('channel_taxonomy').select('category_id')
    .eq('channel', channel).eq('active', true).eq('leaf', true).in('category_id', ids);
  if (activeError) throw new Error(activeError.message);
  return (active || []).map((row) => row.category_id);
}

async function syncEbay(storeId) {
  const tree = await retryLimited(() => fetchCategoryTree());
  const rows = ebayRows(tree.root);
  const version = `${tree.treeId}:${tree.version || digest(rows)}`;
  const result = await upsertSnapshot("ebay", storeId, version, rows);
  for (const categoryId of await usedCategoryIds("ebay", storeId)) {
    await refreshChannelCategoryFields('ebay', storeId, categoryId);
  }
  return result;
}

async function syncTiktok(storeId) {
  const json = await retryLimited(() => tiktokApiFetch(storeId, "GET", "/product/202309/categories", null,
    { category_version: "v2", shop_cipher: process.env.TIKTOK_SHOP_SHOP_CIPHER || undefined }));
  if (json?.code !== 0) throw new Error(json?.message || "tiktok_categories_failed");
  const rows = flatRows(json?.data?.categories || [], "id", "local_name", "is_leaf");
  const version = `v2:${digest(rows)}`;
  const result = await upsertSnapshot("tiktok", storeId, version, rows);
  for (const categoryId of await usedCategoryIds("tiktok", storeId)) {
    await refreshChannelCategoryFields('tiktok', storeId, categoryId);
  }
  return result;
}

async function syncAmazon(storeId) {
  const types = [];
  let nextToken = null;
  do {
    const path = `/definitions/2020-09-01/productTypes?marketplaceIds=${marketplaceId()}` +
      (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : "");
    const page = await retryLimited(() => spapiFetch(storeId, "GET", path));
    types.push(...(page.productTypes || []));
    nextToken = page.nextToken || null;
  } while (nextToken);
  const rows = types.map((item) => ({ category_id: String(item.name || ""), parent_id: null,
    path: String(item.displayName || item.name || ""), leaf: true, active: true }));
  const result = await upsertSnapshot("amazon", storeId, digest(rows), rows);
  for (const categoryId of await usedCategoryIds("amazon", storeId)) {
    await refreshChannelCategoryFields('amazon', storeId, categoryId);
  }
  return result;
}

export async function syncChannelTaxonomy(channel, storeId) {
  const sb = serviceClient();
  const { data: run, error } = await sb.from("category_sync_runs").insert({ channel, store_id: storeId, status: "running" }).select("id").single();
  if (error) throw new Error(error.message);
  try {
    const result = channel === "ebay" ? await syncEbay(storeId)
      : channel === "tiktok" ? await syncTiktok(storeId)
        : channel === "amazon" ? await syncAmazon(storeId)
          : (() => { throw new Error("unsupported_category_channel"); })();
    await sb.from("category_sync_runs").update({ status: "complete", category_count: result.count,
      version: result.version, finished_at: new Date().toISOString() }).eq("id", run.id);
    return result;
  } catch (failure) {
    await sb.from("category_sync_runs").update({ status: "error", error: String(failure).slice(0, 500),
      finished_at: new Date().toISOString() }).eq("id", run.id);
    throw failure;
  }
}
