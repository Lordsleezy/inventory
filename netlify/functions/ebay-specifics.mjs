// eBay required item specifics for Receive / item edit. No AI: eBay Taxonomy + Catalog APIs and Floor's UPC data only.
// Staff (clerks) may use it; it never returns money fields or channel checkboxes.
import { json, corsHeaders, serviceClient, staffFromEvent } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { catalogProductByGtin, suggestCategories } from "../lib/ebay-catalog.mjs";
import { refreshChannelCategoryFields } from "../lib/category-taxonomy.mjs";
import { autofillUnitSpecifics, missingRequired, supabaseSpecificsDeps } from "../lib/ebay-specifics.mjs";
import { normalizeGtin } from "../lib/gtin-normalize.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";

const FIELDS_MAX_AGE_MS = 7 * 86400000;

async function storeFor(event, hint) {
  try { return (await portalAdminFromEvent(event, hint)).storeId; }
  catch {
    const { staff } = await staffFromEvent(event);
    if (!staff?.store_id || staff.deactivated_at) throw Object.assign(new Error("not_allowed"), { status: 403 });
    return staff.store_id;
  }
}

/** Cached aspect fields for an eBay leaf category; refreshed from Taxonomy when missing or older than 7 days. */
export async function ebayAspectFields(storeId, categoryId) {
  const sb = serviceClient();
  const read = async () => (await sb.from("channel_taxonomy").select("aspect_fields,required_fields,fields_fetched_at")
    .eq("channel", "ebay").eq("category_id", categoryId).maybeSingle()).data;
  let row = await read();
  const fresh = row?.fields_fetched_at && Date.parse(row.fields_fetched_at) > Date.now() - FIELDS_MAX_AGE_MS;
  if (!fresh || !row?.aspect_fields?.length) {
    await refreshChannelCategoryFields("ebay", storeId, categoryId).catch(() => {});
    row = await read();
  }
  return row?.aspect_fields?.length ? row.aspect_fields : row?.required_fields || [];
}

async function form(sb, storeId, sku) {
  const { data: unit } = await sb.from("units").select("sku,title,brand,model,upc").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (!unit) throw Object.assign(new Error("unknown_sku"), { status: 404 });
  const { data: row } = await sb.from("unit_channel_categories").select("category_id,attributes,enabled")
    .eq("store_id", storeId).eq("sku", sku).eq("channel", "ebay").maybeSingle();
  let suggestion = null;
  if (!row?.category_id) {
    const query = unit.title || [unit.brand, unit.model].filter(Boolean).join(" ");
    for (const s of await suggestCategories(query).catch(() => [])) {
      const { data: t } = await sb.from("channel_taxonomy").select("category_id,path")
        .eq("channel", "ebay").eq("category_id", s.categoryId).eq("active", true).eq("leaf", true).maybeSingle();
      if (t) { suggestion = t; break; }
    }
  }
  const fields = row?.category_id ? await ebayAspectFields(storeId, row.category_id) : [];
  const { data: tax } = row?.category_id ? await sb.from("channel_taxonomy").select("path")
    .eq("channel", "ebay").eq("category_id", row.category_id).maybeSingle() : { data: null };
  return { sku, title: unit.title, upc: unit.upc, enabled: row?.enabled ?? false, category_id: row?.category_id || null,
    path: tax?.path || null, suggestion, fields, attributes: row?.attributes || {},
    missing: missingRequired(fields, row?.attributes || {}) };
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  try {
    const body = JSON.parse(event.body || "{}");
    const storeId = await storeFor(event, body.store_id);
    const sku = String(body.sku || "").trim();
    if (!sku) return json(400, { error: "sku_required" });
    const sb = serviceClient();
    const deps = supabaseSpecificsDeps(sb, { catalog: catalogProductByGtin, aspectFields: (id) => ebayAspectFields(storeId, id) });
    if (body.action === "autofill") {
      const result = await autofillUnitSpecifics(deps, storeId, sku);
      return json(200, { ok: true, result, form: await form(sb, storeId, sku) });
    }
    if (body.action === "remember") {
      const current = await form(sb, storeId, sku);
      const gtin = normalizeGtin(current.upc);
      const complete = Boolean(current.category_id && current.fields.length && !current.missing.length);
      if (complete && gtin.ok) await deps.remember(gtin.gtin14, { categoryId: current.category_id, attributes: current.attributes });
      return json(200, { ok: true, remembered: complete && gtin.ok, form: current });
    }
    return json(200, { ok: true, form: await form(sb, storeId, sku) });
  } catch (error) { return json(error?.status || 500, { ok: false, error: String(error?.message || error) }); }
}

export const invoke = wrapHandler("ebay-specifics", handle);
export default asNetlifyFunction(invoke);
