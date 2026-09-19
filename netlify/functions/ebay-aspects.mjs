import { staffFromEvent, json, corsHeaders, serviceClient } from "../lib/server.mjs";
import {
  FLOOR_EBAY_CATEGORIES,
  loadStoredAspects,
  mergeAspectOverride,
  prepareUnitAspects,
  rememberAspectDefault,
  resolveFloorCategory,
  refreshCategoryAspects,
  refreshCategoryConditions,
} from "../lib/ebay-catalog.mjs";
import { parseListingSpecs } from "../lib/listing-copy.mjs";
import { unitSpecificAspect } from "../lib/ebay-aspects.mjs";

async function loadUnit(storeId, sku) {
  const sb = serviceClient();
  const { data, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No unit ${sku}`);
  return data;
}

async function saveSpecs(storeId, sku, specs) {
  const sb = serviceClient();
  const { error } = await sb
    .from("units")
    .update({ listing_specs: specs, updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", sku);
  if (error) throw new Error(error.message);
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const { staff } = await staffFromEvent(event);
    const storeId = staff.store_id;
    if (event.httpMethod === "GET") {
      const params = event.queryStringParameters || {};
      if (params.sku) {
        const unit = await loadUnit(storeId, params.sku);
        const prepared = await prepareUnitAspects({ storeId, unit, liveCheck: params.refresh === "1" });
        return json(200, {
          ok: true,
          category: prepared.floor,
          categories: FLOOR_EBAY_CATEGORIES.map(({ slug, name, ebayCategoryId }) => ({ slug, name, ebayCategoryId })),
          aspects: prepared.ui,
          missing: prepared.missingRequired,
          missingRecommended: prepared.missingRecommended,
          ready: prepared.ready,
          refreshed: prepared.refreshed,
        });
      }
      const floor = resolveFloorCategory(params.category || params.slug || "");
      if (!floor) {
        return json(200, {
          ok: true,
          categories: FLOOR_EBAY_CATEGORIES.map(({ slug, name, ebayCategoryId }) => ({ slug, name, ebayCategoryId })),
        });
      }
      let defs = await loadStoredAspects(floor.ebayCategoryId);
      if (!defs.length || params.refresh === "1") defs = await refreshCategoryAspects(floor.ebayCategoryId);
      return json(200, {
        ok: true,
        category: floor,
        aspects: defs
          .filter((row) => row.required || row.recommended)
          .map((row) => ({ ...row, value: "", source: "" })),
      });
    }
    if (event.httpMethod !== "POST") return json(405, { error: "method" });
    const body = JSON.parse(event.body || "{}");
    if (body.refresh && (body.slug || body.category || body.ebayCategoryId)) {
      const floor = resolveFloorCategory(body.slug || body.category) || FLOOR_EBAY_CATEGORIES.find((c) => c.ebayCategoryId === String(body.ebayCategoryId));
      if (!floor) return json(400, { error: "unmapped_category" });
      await refreshCategoryAspects(floor.ebayCategoryId);
      await refreshCategoryConditions(floor.ebayCategoryId);
      return json(200, { ok: true, category: floor });
    }
    const aspectName = String(body.aspect || body.name || "").trim();
    const value = body.value == null ? "" : String(body.value).trim();
    const skus = Array.isArray(body.skus) ? body.skus.map(String) : body.sku ? [String(body.sku)] : [];
    if (!aspectName || !skus.length) return json(400, { error: "aspect_and_sku_required" });
    let slug = "";
    for (const sku of skus) {
      const unit = await loadUnit(storeId, sku);
      const floor = resolveFloorCategory(unit.category);
      if (!floor) throw new Error(`SKU ${sku} is not in a mapped eBay category.`);
      slug = floor.slug;
      const specs = mergeAspectOverride(parseListingSpecs(unit.listing_specs) || {}, aspectName, value);
      await saveSpecs(storeId, sku, specs);
    }
    if (body.remember !== false && value && !unitSpecificAspect(aspectName) && slug) {
      await rememberAspectDefault(storeId, slug, aspectName, value);
    }
    return json(200, { ok: true, skus, aspect: aspectName, value });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err?.code === "ebay_category_unmapped" ? 400 : 400;
    return json(code, { error: err?.code || "ebay_aspects_failed", message });
  }
}
