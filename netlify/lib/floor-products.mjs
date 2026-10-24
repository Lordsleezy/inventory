/**
 * Shared Floor UPC product catalog (floor_products) + miss log helpers.
 * service_role only — called from upc-lookup and receive-photo-identify.
 */
import { itemSpecificsFromLookup, usableModelNumber, variantFromTitle } from "./amazon.mjs";

const PKG_KEYS = ["length_in", "width_in", "height_in", "weight_lb"];

function clean(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Compose listing title = brand + item specifics. */
export function listingTitle(brand, model, unbranded = false) {
  const b = unbranded ? "Unbranded" : clean(brand) || "";
  const m = clean(model) || "";
  return [b, m].filter(Boolean).join(" ");
}

/** Map a floor_products row into upc-lookup's merged shape. */
export function productToMerged(row) {
  if (!row) return null;
  const model =
    itemSpecificsFromLookup({
      model: row.model,
      aspects: row.aspects,
      title: row.title,
      brand: row.brand,
    }) ||
    null;
  const brand = clean(row.brand);
  return {
    title: clean(row.title) || listingTitle(brand, model),
    brand,
    model,
    description: clean(row.description),
    features: Array.isArray(row.features) ? row.features : [],
    aspects: row.aspects && typeof row.aspects === "object" ? row.aspects : {},
    package: {
      length_in: num(row.package_length_in),
      width_in: num(row.package_width_in),
      height_in: num(row.package_height_in),
      weight_lb: num(row.package_weight_lb),
    },
    images: Array.isArray(row.images) ? row.images.filter((u) => typeof u === "string") : [],
    category: clean(row.category),
    asin: clean(row.asin)?.toUpperCase() || null,
    msrp_cents: null,
    retail_cents: null,
    retail_source: null,
    retail_as_of: null,
    disagreements: [],
    not_found: false,
    floor_product: true,
    dim_sources: row.dim_sources && typeof row.dim_sources === "object" ? row.dim_sources : {},
  };
}

export async function readFloorProduct(sb, gtin14) {
  try {
    const { data, error } = await sb.from("floor_products").select("*").eq("gtin14", gtin14).maybeSingle();
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Upsert product from a successful Amazon/UPCitemdb/photo merge.
 * Never stores unit price/condition/cost. Skips rows with no brand+model/title.
 */
export async function saveFloorProduct(sb, gtin, merged, { source = "lookup", actorId = null, dimSources = {} } = {}) {
  if (!gtin?.gtin14 || !merged) return null;
  const model =
    usableModelNumber(merged.model) ||
    itemSpecificsFromLookup({
      model: merged.model,
      aspects: merged.aspects,
      title: merged.title,
      brand: merged.brand,
    }) ||
    variantFromTitle(merged.title, merged.brand) ||
    null;
  const brand = clean(merged.brand);
  const suppliedTitle = clean(merged.title);
  const title = suppliedTitle
    ? (brand && !suppliedTitle.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${suppliedTitle}` : suppliedTitle)
    : listingTitle(brand, model);
  if (!brand && !model && !title) return null;

  const pkg = merged.package || {};
  const dims = {};
  const sources = { ...(dimSources || {}) };
  for (const k of PKG_KEYS) {
    const col = k === "weight_lb" ? "package_weight_lb" : `package_${k}`;
    dims[col] = num(pkg[k === "length_in" ? "length_in" : k === "width_in" ? "width_in" : k === "height_in" ? "height_in" : "weight_lb"]);
    if (dims[col] != null && !sources[k]) sources[k] = "listed";
  }

  const row = {
    gtin14: gtin.gtin14,
    upc_a: gtin.upcA || null,
    ean13: gtin.ean13 || null,
    brand,
    model,
    title,
    category: clean(merged.category),
    description: clean(merged.description),
    aspects: merged.aspects && typeof merged.aspects === "object" ? merged.aspects : {},
    features: Array.isArray(merged.features) ? merged.features : [],
    package_length_in: dims.package_length_in,
    package_width_in: dims.package_width_in,
    package_height_in: dims.package_height_in,
    package_weight_lb: dims.package_weight_lb,
    dim_sources: sources,
    asin: clean(merged.asin)?.toUpperCase() || null,
    images: Array.isArray(merged.images) ? merged.images.slice(0, 8) : [],
    source,
    updated_at: new Date().toISOString(),
    updated_by: actorId,
  };

  try {
    const { data, error } = await sb.from("floor_products").upsert(row, { onConflict: "gtin14" }).select("*").maybeSingle();
    if (error) {
      console.log("floor_product_save_failed", error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.log("floor_product_save_failed", String(e?.message || e));
    return null;
  }
}

/** Persist a true barcode miss (not rate-limit / auth errors). */
export async function logUpcMiss(sb, { gtin, rawCode, storeId, amazon, upcitemdb, amazonAttempts }) {
  if (!gtin?.gtin14) return null;
  const amazonErr = String(amazon?.raw_error || "");
  const upcErr = String(upcitemdb?.raw_error || "");
  const transient =
    /rate.?limit|429|timeout|fetch_failed|401|403|QuotaExceeded/i.test(amazonErr) ||
    /rate.?limit|429|timeout|fetch_failed/i.test(upcErr);
  if (transient) return null;
  if (amazon?.found || upcitemdb?.found) return null;
  try {
    const { data, error } = await sb
      .from("upc_lookup_misses")
      .insert({
        gtin14: gtin.gtin14,
        raw_code: rawCode || gtin.upcA || gtin.ean13 || gtin.gtin14,
        store_id: storeId || null,
        amazon: amazon || null,
        upcitemdb: upcitemdb || null,
        amazon_attempts: amazonAttempts || null,
        looked_up_at: new Date().toISOString(),
      })
      .select("id")
      .maybeSingle();
    if (error) {
      console.log("upc_miss_log_failed", error.message);
      return null;
    }
    return data?.id || null;
  } catch (e) {
    console.log("upc_miss_log_failed", String(e?.message || e));
    return null;
  }
}

export async function attachPhotoIdentityToMiss(sb, { gtin14, identity, missId }) {
  try {
    if (missId) {
      await sb
        .from("upc_lookup_misses")
        .update({ photo_identity: identity })
        .eq("id", missId);
      return;
    }
    if (!gtin14) return;
    const { data } = await sb
      .from("upc_lookup_misses")
      .select("id")
      .eq("gtin14", gtin14)
      .order("looked_up_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.id) {
      await sb.from("upc_lookup_misses").update({ photo_identity: identity }).eq("id", data.id);
    }
  } catch (e) {
    console.log("upc_miss_photo_attach_failed", String(e?.message || e));
  }
}
