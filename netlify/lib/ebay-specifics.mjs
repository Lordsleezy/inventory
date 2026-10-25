/**
 * eBay required item specifics without AI. Sources, in order: Floor's UPC memory (floor_products
 * ebay_category_id/ebay_aspects), eBay Catalog API by UPC, then Floor's product database fields.
 * Never overwrites a value that is already set; never changes an existing category.
 */
import { normalizeGtin } from "./gtin-normalize.mjs";

const text = (value) => String(value ?? "").trim();

/** Fill only blank aspects. Values for selection-only aspects must match an allowed value. */
export function fillMissing(existing = {}, incoming = {}, fields = []) {
  const attributes = { ...(existing || {}) };
  const filled = [];
  const byName = new Map((fields || []).map((def) => [text(def.name).toLowerCase(), def]));
  for (const [rawName, rawValue] of Object.entries(incoming || {})) {
    const def = fields?.length ? byName.get(text(rawName).toLowerCase()) : { name: text(rawName) };
    if (!def?.name || text(attributes[def.name])) continue;
    const values = (Array.isArray(rawValue) ? rawValue : [rawValue]).map(text).filter(Boolean);
    let value = values[0];
    if ((def.selectionOnly || def.selection_only) && def.allowed?.length) {
      value = values.map((v) => def.allowed.find((a) => a.toLowerCase() === v.toLowerCase())).find(Boolean);
    }
    if (!value) continue;
    attributes[def.name] = value;
    filled.push(def.name);
  }
  return { attributes, filled };
}

export function missingRequired(fields = [], attributes = {}) {
  return (fields || []).filter((def) => def.required && (!text(attributes[def.name])
    || ((def.selectionOnly || def.selection_only) && def.allowed?.length && !def.allowed.includes(text(attributes[def.name])))))
    .map((def) => def.name);
}

/** Store every aspect (required first, then recommended, then the rest) in a compact form. */
export function aspectFieldsFromTaxonomy(normalized = []) {
  const rank = (d) => (d.required ? 0 : d.recommended ? 1 : 2);
  return [...normalized].sort((a, b) => rank(a) - rank(b) || a.sortIndex - b.sortIndex)
    .map((d) => ({ name: d.name, required: Boolean(d.required), recommended: Boolean(d.recommended),
      allowed: d.catalog ? [] : d.allowed || [], selection_only: Boolean(d.selectionOnly) }));
}

/** Generic aspects Floor already knows from its product database. */
export function productAspects(product) {
  if (!product) return {};
  return { ...(product.aspects || {}), ...(product.brand ? { Brand: product.brand } : {}),
    ...(product.model ? { Model: product.model, MPN: product.model } : {}) };
}

/**
 * deps: loadUnit(storeId, sku), loadEbayRow(storeId, sku), loadProduct(gtin14), catalog(gtin),
 *       aspectFields(categoryId), saveEbayRow(storeId, sku, patch), remember(gtin14, { categoryId, attributes })
 */
export async function autofillUnitSpecifics(deps, storeId, sku, { write = true } = {}) {
  const unit = await deps.loadUnit(storeId, sku);
  if (!unit) return { sku, ok: false, reason: "unknown_sku" };
  const row = await deps.loadEbayRow(storeId, sku);
  if (row && row.enabled === false) return { sku, ok: true, skipped: "ebay_disabled" };
  const gtin = normalizeGtin(unit.upc);
  const product = gtin.ok ? await deps.loadProduct(gtin.gtin14) : null;
  let categoryId = row?.category_id || null;
  let categorySource = null;
  if (!categoryId && product?.ebay_category_id) { categoryId = product.ebay_category_id; categorySource = "floor_upc_memory"; }
  const memory = product?.ebay_category_id && product.ebay_category_id === categoryId ? product.ebay_aspects || {} : {};
  const before = { ...(row?.attributes || {}) };
  let fields = categoryId ? await deps.aspectFields(categoryId) : [];
  let { attributes, filled } = fillMissing(before, memory, fields);
  let usedCatalog = false;
  if (gtin.ok && (!categoryId || missingRequired(fields, attributes).length)) {
    const hit = await deps.catalog(gtin.upcA || gtin.ean13 || gtin.gtin14).catch(() => null);
    if (hit) {
      usedCatalog = true;
      if (!categoryId && hit.categoryId) {
        categoryId = hit.categoryId; categorySource = "ebay_catalog";
        fields = await deps.aspectFields(categoryId);
        ({ attributes, filled } = fillMissing(before, memory, fields));
      }
      if (categoryId) {
        const more = fillMissing(attributes, hit.aspects || {}, fields);
        attributes = more.attributes; filled = [...filled, ...more.filled];
      }
    }
  }
  if (!categoryId) return { sku, ok: true, complete: false, reason: "no_category", usedCatalog, filled: [] };
  const fromProduct = fillMissing(attributes, productAspects(product), fields);
  attributes = fromProduct.attributes; filled = [...filled, ...fromProduct.filled];
  const missing = missingRequired(fields, attributes);
  const complete = fields.length > 0 && missing.length === 0;
  if (write && (filled.length || categorySource)) {
    await deps.saveEbayRow(storeId, sku, { attributes, ...(categorySource ? { category_id: categoryId, source: categorySource } : {}) });
  }
  if (write && complete && gtin.ok) await deps.remember(gtin.gtin14, { categoryId, attributes });
  return { sku, ok: true, categoryId, categorySource, filled, missing, complete, usedCatalog };
}

/** Supabase-backed deps (service role). */
export function supabaseSpecificsDeps(sb, { catalog, aspectFields }) {
  const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
  return {
    catalog, aspectFields,
    loadUnit: async (storeId, sku) => must(await sb.from("units").select("sku,upc,brand,model,title")
      .eq("store_id", storeId).eq("sku", sku).maybeSingle()),
    loadEbayRow: async (storeId, sku) => must(await sb.from("unit_channel_categories")
      .select("category_id,attributes,enabled,source").eq("store_id", storeId).eq("sku", sku).eq("channel", "ebay").maybeSingle()),
    loadProduct: async (gtin14) => must(await sb.from("floor_products")
      .select("gtin14,brand,model,aspects,ebay_category_id,ebay_aspects").eq("gtin14", gtin14).maybeSingle()),
    saveEbayRow: async (storeId, sku, patch) => {
      const now = new Date().toISOString();
      if (patch.category_id) {
        // Category came from an exact UPC match: confirm it like category-resolve does.
        const tax = must(await sb.from("channel_taxonomy").select("fingerprint,fields_version,fields_fetched_at,active,leaf")
          .eq("channel", "ebay").eq("category_id", patch.category_id).maybeSingle());
        const valid = Boolean(tax?.active && tax.leaf && tax.fields_fetched_at);
        must(await sb.from("unit_channel_categories").upsert({ store_id: storeId, sku, channel: "ebay", enabled: true,
          category_id: patch.category_id, source: patch.source, attributes: patch.attributes, updated_at: now,
          validated_version: valid ? `${tax.fingerprint || ""}:${tax.fields_version || ""}` : null,
          review_reason: valid ? null : "missing category or unsynced fields" }, { onConflict: "store_id,sku,channel" }));
      } else {
        must(await sb.from("unit_channel_categories").update({ attributes: patch.attributes, updated_at: now })
          .eq("store_id", storeId).eq("sku", sku).eq("channel", "ebay"));
      }
    },
    remember: async (gtin14, { categoryId, attributes }) => {
      const now = new Date().toISOString();
      const existing = must(await sb.from("floor_products").select("gtin14").eq("gtin14", gtin14).maybeSingle());
      if (existing) must(await sb.from("floor_products").update({ ebay_category_id: categoryId, ebay_aspects: attributes,
        ebay_confirmed_at: now, updated_at: now }).eq("gtin14", gtin14));
      else must(await sb.from("floor_products").insert({ gtin14, ebay_category_id: categoryId, ebay_aspects: attributes,
        ebay_confirmed_at: now, source: "manual" }));
    },
  };
}
