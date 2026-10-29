// eBay required item specifics for Receive / item edit. No AI: eBay Taxonomy + Catalog APIs and Floor's UPC data only.
// Staff (clerks) may use it; it never returns money fields or channel checkboxes.
import { json, corsHeaders, serviceClient, staffFromEvent } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { catalogProductByGtin, suggestCategories } from "../lib/ebay-catalog.mjs";
import { refreshChannelCategoryFields } from "../lib/category-taxonomy.mjs";
import { autofillUnitSpecifics, missingRequired, supabaseSpecificsDeps } from "../lib/ebay-specifics.mjs";
import { canonicalValue, clearInvalid, countUsage, rankValues } from "../lib/aspect-suggest.mjs";
import { liveSpecificsForUnit } from "../lib/ebay-live-specifics.mjs";
import { autoFillUnit, supabaseAutoFillDeps } from "../lib/auto-fill.mjs";
import { pushEbayDescription } from "../lib/ebay-description-sync.mjs";
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

/** Values already used in Floor for each aspect of a category, most used first (top 12). Never includes values eBay would reject. */
async function usageFor(sb, storeId, categoryId, fields) {
  if (!categoryId) return {};
  const { data } = await sb.from("unit_channel_categories").select("attributes").eq("store_id", storeId).eq("channel", "ebay")
    .eq("category_id", categoryId).limit(3000);
  const counts = countUsage((data || []).map((r) => r.attributes));
  const out = {};
  for (const def of fields) {
    const ranked = rankValues({ ...def, allowed: [] }, counts[def.name]).filter((v) => canonicalValue(def, v) === v).slice(0, 12);
    if (ranked.length) out[def.name] = ranked;
  }
  return out;
}

async function form(sb, storeId, sku) {
  const { data: unit } = await sb.from("units").select("sku,title,brand,model,upc,condition,listing_body,defect_notes").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (!unit) throw Object.assign(new Error("unknown_sku"), { status: 404 });
  const { data: row } = await sb.from("unit_channel_categories").select("category_id,attributes,enabled,source")
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
    path: tax?.path || null, auto_picked: row?.source === "auto_suggested", suggestion, fields, attributes: row?.attributes || {},
    usage: await usageFor(sb, storeId, row?.category_id, fields),
    missing: missingRequired(fields, row?.attributes || {}),
    item: { title: unit.title, brand: unit.brand, model: unit.model, condition: unit.condition,
      description: unit.listing_body || "", defect_notes: unit.defect_notes || "" } };
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
    const deps = supabaseSpecificsDeps(sb, { catalog: catalogProductByGtin, aspectFields: (id) => ebayAspectFields(storeId, id),
      loadLive: (sid, s) => liveSpecificsForUnit(sid, s) });
    if (body.action === "suggest-category") {
      let current = await form(sb, storeId, sku);
      // Category suggestions never enable eBay. Only fill a category for a unit
      // that is already selected for eBay, and preserve any category already set.
      if (!current.enabled || current.category_id) return json(200, { ok: true, form: current });

      // Prefer an exact Floor/UPC/live-listing match before a title suggestion.
      await autofillUnitSpecifics(deps, storeId, sku);
      current = await form(sb, storeId, sku);
      if (!current.category_id) {
        const query = current.item?.title || [current.item?.brand, current.item?.model].filter(Boolean).join(" ");
        for (const suggestion of await suggestCategories(query).catch(() => [])) {
          const { data: tax } = await sb.from("channel_taxonomy").select("category_id,path,active,leaf")
            .eq("channel", "ebay").eq("category_id", suggestion.categoryId).maybeSingle();
          if (!tax?.active || !tax?.leaf) continue;
          await ebayAspectFields(storeId, tax.category_id);
          await deps.saveEbayRow(storeId, sku, { category_id: tax.category_id,
            source: "auto_suggested", attributes: current.attributes || {} });
          break;
        }
      }
      current = await form(sb, storeId, sku);
      if (current.category_id) await autofillUnitSpecifics(deps, storeId, sku);
      return json(200, { ok: true, form: await form(sb, storeId, sku) });
    }
    if (body.action === "autofill") {
      const result = await autofillUnitSpecifics(deps, storeId, sku);
      return json(200, { ok: true, result, form: await form(sb, storeId, sku) });
    }
    if (body.action === "auto-fill") {
      // Receive / title change: pick the category and write the description if they are still blank. Staff may call it; it never ticks a channel.
      const af = supabaseAutoFillDeps(sb, { suggestCategories, specificsDeps: deps, ebayAspectFields: (id) => ebayAspectFields(storeId, id) });
      const [eligible] = await sb.rpc("floor_auto_fill_snapshot", { p_store: storeId, p_sku: sku }).then((r) => r.data || []);
      if (!eligible?.eligible) return json(200, { ok: true, result: { sku, skipped: "not_eligible" }, form: await form(sb, storeId, sku) });
      const result = await autoFillUnit(af, storeId, sku);
      return json(200, { ok: true, result, form: await form(sb, storeId, sku) });
    }
    if (body.action === "preview-category") {
      // Required questions for a category the admin is about to pick, already answered where Floor can (nothing is saved).
      const categoryId = String(body.category_id || "").trim();
      if (!categoryId) return json(400, { error: "category_id_required" });
      const fields = await ebayAspectFields(storeId, categoryId);
      const { data: row } = await sb.from("unit_channel_categories").select("attributes").eq("store_id", storeId).eq("sku", sku).eq("channel", "ebay").maybeSingle();
      const { kept, cleared } = clearInvalid(fields, row?.attributes || {});
      const preview = await autofillUnitSpecifics({ ...deps, aspectFields: async () => fields,
        loadEbayRow: async () => ({ category_id: categoryId, enabled: true, attributes: kept }) }, storeId, sku, { write: false });
      const { data: tax } = await sb.from("channel_taxonomy").select("path").eq("channel", "ebay").eq("category_id", categoryId).maybeSingle();
      return json(200, { ok: true, category_id: categoryId, path: tax?.path || null, fields: fields.filter((f) => f.required || f.recommended),
        attributes: preview.attributes || kept, prefilled: preview.filled || [], missing: preview.missing || [], cleared,
        usage: await usageFor(sb, storeId, categoryId, fields) });
    }
    if (body.action === "category-selected") {
      // The category was just saved. Drop only the old values that are not valid here, add the answers chosen in the category step, then fill the rest.
      const current = await form(sb, storeId, sku);
      const { kept, cleared } = clearInvalid(current.fields, current.attributes);
      const chosen = {};
      for (const def of current.fields) {
        const v = canonicalValue(def, body.attributes?.[def.name]);
        if (v && !String(kept[def.name] || "").trim()) chosen[def.name] = v;
      }
      const merged = { ...kept, ...chosen };
      if (cleared.length || Object.keys(chosen).length) await deps.saveEbayRow(storeId, sku, { attributes: merged });
      const result = await autofillUnitSpecifics(deps, storeId, sku);
      return json(200, { ok: true, filled: result.filled || [], cleared, result, form: await form(sb, storeId, sku) });
    }
    if (body.action === "sync-description") {
      // Admins only: copies the saved description to the live eBay listing. Price, shipping and promotions are not touched.
      await portalAdminFromEvent(event, body.store_id);
      const pushed = await pushEbayDescription(storeId, sku);
      return json(200, { ok: true, ...pushed });
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
