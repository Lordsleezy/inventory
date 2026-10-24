/**
 * UPC / GTIN product lookup for Floor ("scan to list").
 *
 * Sources (in order of trust): Amazon SP-API Catalog + Pricing → UPCitemdb (fills gaps only)
 * → optional eBay sold comps. Nothing is invented: a field is null/[] unless a source returned it.
 *
 * Cache: public.upc_lookup_cache (service_role only), keyed by gtin14. A hit returns the stored
 * result with cached:true and makes NO external calls unless { force: true }.
 *
 * Read-only: this module never lists anything.
 */
import { serviceClient } from "./server.mjs";
import { normalizeGtin } from "./gtin-normalize.mjs";
import {
  catalogItemByIdentifier,
  competitivePriceByAsin,
  amazonNeverListReason,
  itemSpecificsFromLookup,
  usableModelNumber,
} from "./amazon.mjs";
import {
  logUpcMiss,
  productToMerged,
  readFloorProduct,
  saveFloorProduct,
} from "./floor-products.mjs";

const UPCITEMDB_TRIAL = "https://api.upcitemdb.com/prod/trial/lookup";
const UPCITEMDB_PAID = "https://api.upcitemdb.com/prod/v1/lookup";
const FETCH_TIMEOUT_MS = 8000;

const EMPTY_PKG = () => ({ length_in: null, width_in: null, height_in: null, weight_lb: null });
const PKG_KEYS = ["length_in", "width_in", "height_in", "weight_lb"];

const norm = (v) => String(v ?? "").trim().toLowerCase();
const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ---------------------------------------------------------------------------
// UPCitemdb
// ---------------------------------------------------------------------------

const UNIT_IN = { in: 1, inch: 1, inches: 1, '"': 1, ft: 12, feet: 12, cm: 1 / 2.54, mm: 1 / 25.4 };
const UNIT_LB = { lb: 1, lbs: 1, pound: 1, pounds: 1, oz: 1 / 16, ounce: 1 / 16, ounces: 1 / 16, g: 0.00220462, gram: 0.00220462, grams: 0.00220462, kg: 2.20462, kilogram: 2.20462, kilograms: 2.20462 };
const r2 = (n) => Math.round(n * 100) / 100;

/** "10.2 x 5 x 3 inches" → {length_in,width_in,height_in}; null parts when not clearly parseable. */
export function parseUpcitemdbDimension(str) {
  const out = { length_in: null, width_in: null, height_in: null };
  const m = String(str || "")
    .toLowerCase()
    .match(/(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*([a-z"]+)?/);
  if (!m) return out;
  const f = UNIT_IN[m[4] || ""];
  if (!f) return out; // no/unknown unit: refuse to guess
  out.length_in = r2(Number(m[1]) * f);
  out.width_in = r2(Number(m[2]) * f);
  out.height_in = r2(Number(m[3]) * f);
  return out;
}

/** "1.5 lbs" / "22 Ounces" → pounds, or null. */
export function parseUpcitemdbWeight(str) {
  const m = String(str || "")
    .toLowerCase()
    .match(/(\d+(?:\.\d+)?)\s*([a-z]+)/);
  const f = m && UNIT_LB[m[2]];
  return f ? r2(Number(m[1]) * f) : null;
}

export function parseUpcitemdbItem(item) {
  if (!item) return null;
  const offers = Array.isArray(item.offers) ? item.offers : [];
  const newPrices = offers
    .filter((o) => /^new$/i.test(String(o?.condition || "")))
    .map((o) => Math.round(Number(o.price) * 100))
    .filter((c) => Number.isFinite(c) && c > 0);
  const listPrices = offers.map((o) => Math.round(Number(o.list_price) * 100)).filter((c) => Number.isFinite(c) && c > 0);
  const updated = offers.map((o) => Number(o.updated_t)).filter((t) => Number.isFinite(t) && t > 0);
  const dims = parseUpcitemdbDimension(item.dimension);
  return {
    title: clean(item.title),
    brand: clean(item.brand),
    // Drop retailer digit codes (same rule as Amazon parse) — not usable as item specifics.
    model: usableModelNumber(clean(item.model)),
    description: clean(item.description),
    category: clean(item.category),
    asin: clean(item.asin)?.toUpperCase() || null,
    images: (Array.isArray(item.images) ? item.images : []).filter((u) => typeof u === "string" && /^https?:/i.test(u)),
    package: { ...dims, weight_lb: parseUpcitemdbWeight(item.weight) },
    dimension_raw: clean(item.dimension),
    weight_raw: clean(item.weight),
    price_cents: median(newPrices),
    price_source: newPrices.length ? "upcitemdb_new_offers_median" : null,
    price_as_of: updated.length ? new Date(Math.max(...updated) * 1000).toISOString() : null,
    msrp_cents: median(listPrices),
    offer_count: offers.length,
    // Keep merchant offers for retail audits (Walmart / Best Buy / etc.).
    offers: offers
      .map((o) => ({
        merchant: clean(o.merchant) || clean(o.domain),
        domain: clean(o.domain),
        price: o.price,
        list_price: o.list_price,
        condition: clean(o.condition),
        link: clean(o.link) || clean(o.url),
      }))
      .filter((o) => o.merchant || o.domain),
  };
}

/** @returns {Promise<object>} { found, ...parsed } or { found:false, raw_error } */
export async function upcitemdbLookup(code, { fetchImpl = fetch, key = process.env.UPCITEMDB_KEY } = {}) {
  const useKey = Boolean(key && String(key).trim());
  const url = `${useKey ? UPCITEMDB_PAID : UPCITEMDB_TRIAL}?upc=${encodeURIComponent(code)}`;
  const headers = { Accept: "application/json" };
  if (useKey) {
    headers.user_key = String(key).trim();
    headers.key_type = "3scale";
  }
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const remaining = res.headers?.get?.("x-ratelimit-remaining");
    const tier = useKey ? "keyed" : "trial";
    if (res.status === 429) return { found: false, tier, raw_error: "upcitemdb_rate_limited" };
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // INVALID_UPC / NOT_FOUND style answers are a clean "not found", not an outage.
      if (res.status === 400 || res.status === 404) return { found: false, tier, code: body?.code || null };
      return { found: false, tier, raw_error: `upcitemdb_${res.status}: ${String(body?.message || body?.code || "").slice(0, 200)}` };
    }
    const parsed = parseUpcitemdbItem(body?.items?.[0]);
    return {
      found: Boolean(parsed && (parsed.title || parsed.brand || parsed.model)),
      tier,
      rate_remaining: remaining != null ? Number(remaining) : null,
      ...(parsed || {}),
    };
  } catch (e) {
    return { found: false, raw_error: `upcitemdb_${e?.name === "TimeoutError" ? "timeout" : "fetch_failed"}` };
  }
}

// ---------------------------------------------------------------------------
// Amazon (catalog + price)
// ---------------------------------------------------------------------------

function emptyAmazon(extra = {}) {
  return {
    found: false,
    asin: null,
    title: null,
    brand: null,
    model: null,
    description: null,
    features: [],
    aspects: {},
    package: EMPTY_PKG(),
    item: EMPTY_PKG(),
    images: [],
    category: null,
    product_type: null,
    msrp_cents: null,
    price_cents: null,
    price_source: null,
    price_as_of: null,
    ...extra,
  };
}

async function amazonLookup(storeId, gtin, deps) {
  const isUpc = gtin.gtin14.startsWith("00");
  const attempts = [];
  const tryId = async (type, value) => {
    if (!value) return null;
    try {
      const res = await deps.catalogByIdentifier(storeId, type, value);
      attempts.push({ type, value, found: Boolean(res?.found), alt: (res?.alternatives || []).length });
      return res;
    } catch (e) {
      attempts.push({ type, value, found: false, error: String(e?.message || e).slice(0, 200) });
      throw e;
    }
  };
  let res;
  try {
    // UPC-A → EAN-13 (leading 0) → GTIN-14 so padded codes don't silently miss.
    if (isUpc) {
      res = await tryId("UPC", gtin.upcA);
      if (!res?.found) res = await tryId("EAN", gtin.ean13);
      if (!res?.found) res = await tryId("GTIN", gtin.gtin14);
    } else if (gtin.gtin14.startsWith("0")) {
      res = await tryId("EAN", gtin.ean13);
      if (!res?.found) res = await tryId("GTIN", gtin.gtin14);
      if (!res?.found && gtin.upcA) res = await tryId("UPC", gtin.upcA);
    } else {
      res = await tryId("GTIN", gtin.gtin14);
      if (!res?.found) res = await tryId("EAN", gtin.ean13);
    }
  } catch (e) {
    return emptyAmazon({ raw_error: String(e?.message || e).slice(0, 300), amazon_attempts: attempts });
  }
  if (!res?.found) return emptyAmazon({ alternatives: res?.alternatives || [], amazon_attempts: attempts });

  const it = res.item;
  const out = emptyAmazon({
    found: true,
    asin: it.asin,
    title: it.title,
    brand: it.brand,
    model: it.model,
    description: it.description,
    features: it.features || [],
    aspects: it.aspects && typeof it.aspects === "object" ? it.aspects : {},
    package: it.package || EMPTY_PKG(),
    item: it.item || EMPTY_PKG(),
    images: it.images || [],
    category: it.category,
    product_type: it.product_type,
    msrp_cents: it.msrp_cents,
    alternatives: res.alternatives || [],
  });

  const price = deps.skipPrice ? {} : await deps.priceByAsin(storeId, it.asin).catch((e) => ({
    price_cents: null,
    raw_error: String(e?.message || e).slice(0, 300),
    price_pending: /429|rate.?limit|QuotaExceeded/i.test(String(e?.message || e?.status || "")),
  }));
  out.price_cents = price.price_cents ?? null;
  out.price_source = price.price_cents ? `amazon_${price.source}` : null;
  out.price_as_of = price.price_cents ? price.as_of : null;
  if (price.price_pending) out.price_pending = true;
  if (price.raw_error) out.price_error = price.raw_error;
  out.amazon_attempts = attempts;
  // Rate-limited pricing must never fail the whole lookup — catalog data still stands.
  return out;
}

// ---------------------------------------------------------------------------
// eBay sold comps (best effort)
// ---------------------------------------------------------------------------

/**
 * eBay's sold-item data lives in the Marketplace Insights API, which eBay only grants to approved apps.
 * If the connection or scope is missing, this returns null (never throws, never blocks a lookup).
 */
export async function ebaySoldComps(storeId, gtin) {
  try {
    const ebay = await import("./ebay.mjs");
    const status = await ebay.ebayConnectionStatus(storeId);
    if (!status?.connected || status?.disabled) return null;
    const q = gtin.upcA && gtin.gtin14.startsWith("00") ? gtin.upcA : gtin.ean13;
    const json = await ebay.ebayFetch(storeId, "GET", `/buy/marketplace_insights/v1_beta/item_sales/search?gtin=${encodeURIComponent(q)}&limit=20`);
    const sold = (json?.itemSales || [])
      .map((s) => ({
        title: clean(s.title),
        price_cents: Math.round(Number(s.lastSoldPrice?.value) * 100) || null,
        condition: clean(s.condition),
        sold_at: s.lastSoldDate || null,
      }))
      .filter((s) => s.price_cents);
    return {
      found: sold.length > 0,
      sold_comps: sold.slice(0, 20),
      median_cents: median(sold.map((s) => s.price_cents)),
      count: sold.length,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function mergePackage(a, u) {
  const out = EMPTY_PKG();
  const from = {};
  for (const k of PKG_KEYS) {
    if (a?.[k] != null) {
      out[k] = a[k];
      from[k] = "amazon";
    } else if (u?.[k] != null) {
      out[k] = u[k];
      from[k] = "upcitemdb";
    }
  }
  const srcs = new Set(Object.values(from));
  const coverage = srcs.size === 0 ? null : srcs.size === 1 ? [...srcs][0] : "mixed";
  return { package: out, coverage };
}

export function mergeLookup(amazon, upc) {
  const A = amazon?.found ? amazon : null;
  const U = upc?.found ? upc : null;
  const pick = (field) => {
    const a = clean(A?.[field]);
    if (a) return [a, "amazon"];
    const u = clean(U?.[field]);
    return u ? [u, "upcitemdb"] : [null, null];
  };

  const [title, titleSrc] = pick("title");
  const [brand, brandSrc] = pick("brand");
  // Prefer a real MPN; never keep bare digit retailer codes in merged.model.
  const pickModel = () => {
    const a = usableModelNumber(clean(A?.model));
    if (a) return [a, "amazon"];
    const u = usableModelNumber(clean(U?.model));
    return u ? [u, "upcitemdb"] : [null, null];
  };
  const [model, modelSrc] = pickModel();
  const [description, descSrc] = pick("description");
  const [category] = pick("category");
  const [asin, asinSrc] = A?.asin ? [A.asin, "amazon"] : U?.asin ? [U.asin, "upcitemdb"] : [null, null];
  const { package: pkg, coverage: pkgSrc } = mergePackage(A?.package, U?.package);

  const useAmazonImages = Boolean(A?.images?.length);
  const images = useAmazonImages ? A.images : U?.images || [];
  const imagesSrc = images.length ? (useAmazonImages ? "amazon" : "upcitemdb") : null;

  let retail_cents = null;
  let retail_source = null;
  let retail_as_of = null;
  if (A?.price_cents) {
    retail_cents = A.price_cents;
    retail_source = A.price_source;
    retail_as_of = A.price_as_of;
  } else if (U?.price_cents) {
    retail_cents = U.price_cents;
    retail_source = U.price_source;
    retail_as_of = U.price_as_of;
  }
  const msrp_cents = A?.msrp_cents || U?.msrp_cents || null;

  const disagreements = [];
  if (A && U) {
    for (const field of ["title", "brand", "model"]) {
      const a = clean(A[field]);
      const u = clean(U[field]);
      if (a && u && norm(a) !== norm(u)) disagreements.push({ field, amazon: a, upcitemdb: u });
    }
    if (A.asin && U.asin && norm(A.asin) !== norm(U.asin)) disagreements.push({ field: "asin", amazon: A.asin, upcitemdb: U.asin });
    for (const k of PKG_KEYS) {
      const a = A.package?.[k];
      const u = U.package?.[k];
      if (a != null && u != null && Math.abs(a - u) > Math.max(0.5, 0.15 * Math.max(a, u))) {
        disagreements.push({ field: `package.${k}`, amazon: a, upcitemdb: u });
      }
    }
  }

  const aspects = A?.aspects && typeof A.aspects === "object" && Object.keys(A.aspects).length
    ? A.aspects
    : U?.aspects && typeof U.aspects === "object" && Object.keys(U.aspects).length
      ? U.aspects
      : {};

  return {
    merged: {
      title,
      brand,
      model,
      description,
      features: A?.features || [],
      aspects,
      package: pkg,
      images,
      category,
      asin,
      msrp_cents,
      retail_cents,
      retail_source,
      retail_as_of,
      disagreements,
      // True when neither source returned a usable catalog hit.
      not_found: !A && !U,
    },
    fieldCoverage: {
      title: titleSrc,
      brand: brandSrc,
      model: modelSrc,
      price: retail_cents ? (A?.price_cents ? "amazon" : "upcitemdb") : null,
      description: descSrc,
      package: pkgSrc,
      images: imagesSrc,
      asin: asinSrc,
      aspects: Object.keys(aspects).length ? (A?.aspects && Object.keys(A.aspects).length ? "amazon" : "upcitemdb") : null,
    },
  };
}

/** True when Amazon alone filled every field we care about (so UPCitemdb's free quota can be spared). */
export function amazonIsComplete(a) {
  return Boolean(
    a?.found &&
      a.title &&
      a.brand &&
      a.model &&
      a.description &&
      a.images?.length &&
      a.price_cents &&
      PKG_KEYS.every((k) => a.package?.[k] != null),
  );
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

async function readCache(sb, gtin14) {
  try {
    const { data, error } = await sb.from("upc_lookup_cache").select("*").eq("gtin14", gtin14).maybeSingle();
    if (error || !data?.payload) return null;
    // A negative result may reflect temporary catalog coverage or a trial-tier gap.
    // Recheck sources on the next scan instead of pinning a miss indefinitely.
    if (!data.payload.amazon?.found && !data.payload.upcitemdb?.found) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCache(sb, gtin14, result) {
  try {
    const { cached: _c, ...payload } = result;
    const { error } = await sb.from("upc_lookup_cache").upsert(
      {
        gtin14,
        payload,
        amazon: result.amazon,
        upcitemdb: result.upcitemdb,
        ebay: result.ebay,
        looked_up_at: result.looked_up_at,
      },
      { onConflict: "gtin14" },
    );
    if (error) console.log("upc_cache_write_failed", error.message);
    return !error;
  } catch (e) {
    console.log("upc_cache_write_failed", String(e?.message || e));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * @param {string} storeId
 * @param {string} rawCode  scanned barcode (UPC-A, UPC-E, EAN-13, GTIN-14)
 * @param {{ force?: boolean, compareUpcitemdb?: boolean, skipEbay?: boolean, deps?: object }} [opts]
 *   force: bypass cache. compareUpcitemdb: call UPCitemdb even if Amazon is complete (to detect disagreements).
 */
export async function lookupUpc(storeId, rawCode, opts = {}) {
  const gtin = normalizeGtin(rawCode);
  if (!gtin.ok) {
    throw Object.assign(new Error(`invalid_gtin: ${gtin.issue}`), { status: 400, code: "invalid_gtin" });
  }
  const gtinOut = { gtin14: gtin.gtin14, upcA: gtin.upcA, ean13: gtin.ean13 };
  const deps = {
    catalogByIdentifier: catalogItemByIdentifier,
    priceByAsin: competitivePriceByAsin,
    upcitemdb: upcitemdbLookup,
    ebayComps: ebaySoldComps,
    sb: null,
    ...(opts.deps || {}),
  };
  const sb = deps.sb || serviceClient();

  // Background dimension enrichment must not rewrite a staff-confirmed Floor product.
  // Catalog and UPCitemdb run together; Amazon pricing and eBay are irrelevant here.
  if (opts.dimensionsOnly) {
    deps.skipPrice = true;
    const code = gtin.gtin14.startsWith("00") ? gtin.upcA : gtin.ean13;
    const [amazon, upcitemdb] = await Promise.all([
      amazonLookup(storeId, gtin, deps), deps.upcitemdb(code),
    ]);
    return { gtin: gtinOut, amazon, upcitemdb };
  }

  // Own product DB first (shared across stores) — permanent edits beat cache/API.
  if (!opts.force) {
    const owned = await readFloorProduct(sb, gtin.gtin14);
    if (owned && (owned.brand || owned.model || owned.title)) {
      const merged = productToMerged(owned);
      return {
        gtin: gtinOut,
        cached: false,
        floor_product: true,
        amazon: { found: false, skipped: "floor_product" },
        upcitemdb: { found: false, skipped: "floor_product" },
        ebay: null,
        merged,
        fieldCoverage: {
          title: "floor_product",
          brand: "floor_product",
          model: "floor_product",
          price: null,
          description: merged.description ? "floor_product" : null,
          package: PKG_KEYS.some((k) => merged.package?.[k] != null) ? "floor_product" : null,
          images: merged.images?.length ? "floor_product" : null,
          asin: merged.asin ? "floor_product" : null,
          aspects: Object.keys(merged.aspects || {}).length ? "floor_product" : null,
        },
        looked_up_at: owned.updated_at || new Date().toISOString(),
      };
    }
  }

  if (!opts.force) {
    const hit = await readCache(sb, gtin.gtin14);
    if (hit) return { ...hit.payload, gtin: gtinOut, cached: true, looked_up_at: hit.looked_up_at || hit.payload?.looked_up_at || null };
  }

  const amazon = await amazonLookup(storeId, gtin, deps);

  let upcitemdb;
  const code = gtin.gtin14.startsWith("00") ? gtin.upcA : gtin.ean13;
  if (amazonIsComplete(amazon) && !opts.compareUpcitemdb) {
    upcitemdb = { found: false, skipped: "amazon_complete" };
  } else {
    upcitemdb = await deps.upcitemdb(code);
  }

  const ebay = opts.skipEbay ? null : await deps.ebayComps(storeId, gtin).catch(() => null);

  const { merged, fieldCoverage } = mergeLookup(amazon, upcitemdb);
  // Prefer pack/variant phrase over bare digit retailer codes for item specifics.
  const specifics = itemSpecificsFromLookup({
    model: merged.model,
    aspects: merged.aspects,
    title: merged.title,
    brand: merged.brand,
  });
  if (specifics) merged.model = specifics;
  const never = amazonNeverListReason({ title: merged.title, brand: merged.brand, model: merged.model, category: merged.category });
  if (never) merged.never_list_reason = never;

  const result = {
    gtin: gtinOut,
    cached: false,
    amazon,
    upcitemdb,
    ebay,
    merged,
    fieldCoverage,
    looked_up_at: new Date().toISOString(),
  };

  // True miss → log for paid-DB evaluation / photo fallback. Transient errors skipped.
  if (!amazon.found && !upcitemdb.found) {
    const missId = await logUpcMiss(sb, {
      gtin,
      rawCode,
      storeId,
      amazon,
      upcitemdb,
      amazonAttempts: amazon.amazon_attempts || null,
    });
    if (missId) result.miss_id = missId;
    result.true_miss = !amazon.raw_error && !upcitemdb.raw_error;
  } else if (merged.title || merged.brand) {
    const src = amazon.found ? "amazon" : "upcitemdb";
    await saveFloorProduct(sb, gtin, merged, { source: src });
  }

  // Don't cache hard failures. Pricing rate-limits are OK to cache catalog without price
  // (price_pending) so the next scan still gets title/dims instantly.
  const hardFail = Boolean(amazon.raw_error && !amazon.found) || Boolean(upcitemdb.raw_error && !upcitemdb.found && !amazon.found);
  const pricingOnlyPending = Boolean(amazon.price_pending || amazon.price_error === "amazon_pricing_rate_limited");
  if (!hardFail && (amazon.found || upcitemdb.found)) {
    if (pricingOnlyPending && !amazon.price_cents) {
      // Cache catalog; leave price null so a later force can refresh pricing.
      const toCache = {
        ...result,
        amazon: { ...amazon, price_pending: true },
        merged: { ...merged, retail_cents: merged.retail_cents || upcitemdb.price_cents || null },
      };
      await writeCache(sb, gtin.gtin14, toCache);
    } else if (!amazon.price_error || pricingOnlyPending) {
      await writeCache(sb, gtin.gtin14, result);
    } else {
      result.cache_skipped = "transient_error";
    }
  } else {
    result.cache_skipped = "transient_error";
  }

  return result;
}
