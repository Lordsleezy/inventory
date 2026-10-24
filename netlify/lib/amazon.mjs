/**
 * Amazon Selling Partner API (SP-API) — private app for our own seller account.
 *
 * Auth: LWA refresh token (env AMAZON_REFRESH_TOKEN and/or connections.refresh_ciphertext).
 * No restricted roles → never request or store buyer PII.
 * Listing gated by AMAZON_LISTING_ENABLED=1. Never upload AI images — catalog ASIN offers only.
 */
import { serviceClient, decryptSecret, encryptSecret, requireEnv } from "./server.mjs";
import { assertBundlePush } from "./bundle-gate.mjs";
import { sendInternalAlert, gmailConfigured } from "./mail.mjs";

const LWA_TOKEN = "https://api.amazon.com/auth/o2/token";
/** US marketplace — not a secret; keep out of Netlify env to save Lambda budget / clutter. */
export const MARKETPLACE_US = "ATVPDKIKX0DER";
const SPAPI_NA = "https://sellingpartnerapi-na.amazon.com";
const NEVER_LIST_SKUS = new Set(["11284"]);
export const STORE_DEFAULT = "5487ca47-6147-4fe8-bc6d-46b6472726ba";

export function amazonListingEnabled() {
  return process.env.AMAZON_LISTING_ENABLED === "1";
}

export function marketplaceId() {
  return MARKETPLACE_US;
}

function spapiHost() {
  // Sandbox only when explicitly requested; production always uses NA endpoint.
  if (process.env.AMAZON_SPAPI_SANDBOX === "1") {
    return "https://sandbox.sellingpartnerapi-na.amazon.com";
  }
  return SPAPI_NA;
}

function sellerId() {
  return process.env.AMAZON_SELLER_ID || "";
}

/** Category/title never-list (scooter, fridge, dishwasher, mattress, rug, oversized). */
export function amazonNeverListReason(unit = {}) {
  const sku = String(unit.sku || "").trim();
  if (sku && NEVER_LIST_SKUS.has(sku)) return "SKU 11284 scooter — never list online";
  const blob = `${unit.category || ""} ${unit.title || ""} ${unit.brand || ""} ${unit.model || ""} ${unit.listing_body || ""}`.toLowerCase();
  if (/\bscooter\b|m365|segway|hoverboard/.test(blob)) return "Electric scooter — never list online";
  if (/fridge|refrigerator|dishwasher|freezer|mattress|box.?spring/.test(blob)) return "Appliance/mattress — never list online";
  if (/\brug\b|carpet|area\s*rug/.test(blob)) return "Rug/carpet — never list online";
  if (/washer(?!\s*fluid)|clothes.?dryer|\brange\b|\bstove\b|\boven\b|cooktop|\bsofa\b|\bcouch\b|loveseat|sectional|recliner|armoire|dresser|wardrobe/.test(blob)) {
    return "Oversized furniture/appliance — never list online";
  }
  const w = Number(unit.package_weight_lb ?? unit.product_weight_lb ?? unit.weight_lb);
  if (Number.isFinite(w) && w > 70) return "Package over 70 lb — never list online";
  return null;
}

async function connectionRow(storeId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("connections")
    .select("*")
    .eq("store_id", storeId)
    .eq("provider", "amazon")
    .eq("status", "connected")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Copy long AMAZON_REFRESH_TOKEN out of Netlify env into encrypted connections (once). */
export async function ensureAmazonRefreshStored(storeId = STORE_DEFAULT) {
  const envRefresh = (process.env.AMAZON_REFRESH_TOKEN || "").trim();
  // Reject CLI-masked placeholders (****…) and truncated pastes.
  if (!envRefresh || envRefresh.length < 40 || envRefresh.includes("*") || !envRefresh.startsWith("Atzr")) {
    return { seeded: false, reason: "no_env_refresh" };
  }
  const sb = serviceClient();
  const { data: row } = await sb
    .from("connections")
    .select("refresh_ciphertext")
    .eq("store_id", storeId)
    .eq("provider", "amazon")
    .maybeSingle();
  if (row?.refresh_ciphertext) return { seeded: false, reason: "already_stored" };
  const { error } = await sb.from("connections").upsert(
    {
      store_id: storeId,
      provider: "amazon",
      status: "connected",
      refresh_ciphertext: encryptSecret(envRefresh),
      account_label: process.env.AMAZON_SELLER_ID || null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "store_id,provider" },
  );
  if (error) return { seeded: false, reason: error.message };
  return { seeded: true, tokenLen: envRefresh.length };
}

async function lwaRefresh(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: requireEnv("AMAZON_LWA_CLIENT_ID"),
    client_secret: requireEnv("AMAZON_LWA_CLIENT_SECRET"),
  });
  const res = await fetch(LWA_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || "amazon_refresh_failed");
    err.status = res.status;
    err.code = json.error || "amazon_refresh_failed";
    throw err;
  }
  return json;
}

async function refreshAccessToken(storeId, row) {
  const envRefresh = (process.env.AMAZON_REFRESH_TOKEN || "").trim();
  const refresh = row?.refresh_ciphertext ? decryptSecret(row.refresh_ciphertext) : envRefresh || null;
  if (!refresh) throw new Error("amazon_no_refresh_token");
  const json = await lwaRefresh(refresh);
  const sb = serviceClient();
  const expiresIn = Number(json.expires_in || 3600);
  if (row?.store_id || storeId) {
    try {
      await sb.from("connections").upsert(
        {
          store_id: storeId,
          provider: "amazon",
          status: "connected",
          token_ciphertext: encryptSecret(json.access_token),
          refresh_ciphertext: row?.refresh_ciphertext || (envRefresh ? encryptSecret(envRefresh) : null),
          expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          updated_at: new Date().toISOString(),
          last_error: null,
          account_label: process.env.AMAZON_SELLER_ID || row?.account_label || null,
          connected_at: row?.connected_at || new Date().toISOString(),
        },
        { onConflict: "store_id,provider" },
      );
    } catch {
      /* best-effort persist */
    }
  }
  return json.access_token;
}

async function accessToken(storeId) {
  const row = await connectionRow(storeId).catch(() => null);
  const exp = row?.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (row?.token_ciphertext && exp > Date.now() + 60_000) {
    return decryptSecret(row.token_ciphertext);
  }
  if (row?.refresh_ciphertext || process.env.AMAZON_REFRESH_TOKEN) {
    return refreshAccessToken(storeId, row);
  }
  throw new Error("amazon_not_connected");
}

export async function spapiFetch(storeId, method, path, body) {
  const token = await accessToken(storeId);
  const headers = {
    "x-amz-access-token": token,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "OpenBoxFloor/1.0 (Language=JavaScript)",
  };
  const res = await fetch(`${spapiHost()}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || json?.message || text.slice(0, 300);
    const err = new Error(`amazon_spapi ${res.status}: ${msg}`);
    err.status = res.status;
    err.body = json;
    err.code = json?.errors?.[0]?.code || null;
    throw err;
  }
  return json;
}

export async function amazonConnectionStatus(storeId = STORE_DEFAULT) {
  const seeded = await ensureAmazonRefreshStored(storeId).catch((e) => ({ seeded: false, reason: String(e) }));
  const clientId = (process.env.AMAZON_LWA_CLIENT_ID || "").trim();
  const hasEnv = Boolean(clientId && process.env.AMAZON_LWA_CLIENT_SECRET);
  const row = await connectionRow(storeId).catch(() => null);
  const envRefreshLen = (process.env.AMAZON_REFRESH_TOKEN || "").trim().length;
  const hasStoredRefresh = Boolean(row?.refresh_ciphertext);
  let healthy = false;
  let participations = null;
  let lastError = row?.last_error || null;
  try {
    if (clientId.startsWith("amzn1.sp.solution") || clientId.startsWith("amzn1.sp.sol")) {
      lastError =
        "AMAZON_LWA_CLIENT_ID looks like an Application ID (amzn1.sp.solution…), not the LWA Client identifier (amzn1.application-oa2-client…). Fix in Netlify env / Seller Central → Develop Apps.";
    } else if (envRefreshLen > 0 && envRefreshLen < 40 && !hasStoredRefresh) {
      lastError =
        "AMAZON_REFRESH_TOKEN looks truncated (len=" +
        envRefreshLen +
        "). Re-paste the full Atzr|… token, or reconnect Amazon so it is stored encrypted in connections.";
    } else {
      const json = await spapiFetch(storeId, "GET", "/sellers/v1/marketplaceParticipations");
      participations = json?.payload || json;
      healthy = true;
      lastError = null;
    }
  } catch (e) {
    lastError = String(e?.message || e).slice(0, 300);
  }
  return {
    connected: Boolean(row?.status === "connected" || envRefreshLen > 40),
    healthy,
    sellerId: sellerId() || row?.account_label || null,
    marketplaceId: marketplaceId(),
    listingEnabled: amazonListingEnabled(),
    hasEnvCreds: hasEnv,
    /** Length of env bootstrap token only; prefer hasStoredRefresh after seed. */
    refreshTokenLength: envRefreshLen,
    hasStoredRefresh,
    lastError,
    participations: Array.isArray(participations)
      ? participations.slice(0, 5).map((p) => ({
          id: p?.marketplace?.id || p?.marketplaceId,
          name: p?.marketplace?.name,
          isParticipating: p?.participation?.isParticipating ?? p?.isParticipating,
        }))
      : null,
    connectedAt: row?.connected_at || null,
    updatedAt: row?.updated_at || null,
    refreshSeed: seeded,
  };
}

export function amazonReferralFeeCents(itemCents) {
  // US referral fee baseline; not worth an env var.
  const pct = 0.15;
  return Math.round(Number(itemCents || 0) * pct);
}

export function defaultCostCents(unit = {}) {
  if (unit?.is_collectible === true) return 0;
  if (Number(unit?.acquisition_cost_cents) > 0) return Number(unit.acquisition_cost_cents);
  const blob = `${unit.category || ""} ${unit.title || ""}`.toLowerCase();
  if (/fridge|refrigerator|dishwasher/.test(blob)) return 25000;
  if (/mattress|box.?spring/.test(blob)) return 30000;
  return 900;
}

export function amazonConditionFromUnit(unit) {
  const cond = String(unit?.condition || "").toLowerCase();
  const body = `${unit?.listing_body || ""} ${unit?.title || ""}`.toLowerCase();
  const sealed =
    (/^(new|brand.?new|sealed)$/i.test(cond) || /sealed|unopened|brand new/.test(cond)) &&
    !/open.?box|used|scratch|dent/.test(cond) &&
    !/open.?box|scratch.?and.?dent/.test(body);
  if (sealed) return { amazon: "new_new", note: "Brand new in original packaging.", confident: true };
  if (/damage|dent|scratch|broken|missing|parts/.test(body) || /fair|poor|damaged|for.?parts/.test(cond)) {
    return {
      amazon: "used_acceptable",
      note: "Open box with noted wear/damage. See seller photos. Contents unused unless stated.",
      confident: true,
    };
  }
  if (/open.?box|like.?new|excellent|unused/.test(cond) || /open.?box/.test(body)) {
    return {
      amazon: "used_like_new",
      note: "OPEN BOX — UNUSED. Packaging may show shelf wear; item itself unused. Real photos on listing.",
      confident: true,
    };
  }
  if (/good|very.?good|used/.test(cond)) {
    return {
      amazon: "used_very_good",
      note: "Open box / used — see condition notes and real photos.",
      confident: true,
    };
  }
  return {
    amazon: null,
    note: null,
    confident: false,
    reason: "Condition unclear from Floor data — confirm New vs open-box before listing.",
  };
}

/** Suggest list price: 40% off retail, cover Amazon fees + $5 profit over cost. Buyer pays ship (template).
 * Optional returnReservePct (from return_settings) bakes a channel return reserve into NEW list prices only —
 * never mutates stored ask_cents / existing listings. */
export function suggestAmazonPriceCents(unit, feePct = 0.15, returnReservePct = 0) {
  const retail =
    Number(unit.retail_cents) ||
    Number(unit.listing_specs?.retail_cents) ||
    Number(unit.listing_specs?.marketplace_pricing?.retail_usd) * 100 ||
    Number(unit.ask_cents) ||
    0;
  const cost = defaultCostCents(unit);
  const isCollectible = unit?.is_collectible === true;
  let target = isCollectible && Number(unit.ask_cents) > 0 ? Number(unit.ask_cents) : Math.round(retail * 0.6);
  if (!Number.isFinite(target) || target <= 0) target = Number(unit.ask_cents) || 0;
  // Ensure net after referral ≥ cost + $5
  const minList = Math.ceil((cost + 500) / (1 - feePct));
  let list = Math.max(target, minList);
  const reserve = Number(returnReservePct) || 0;
  if (reserve > 0 && list > 0) {
    list = Math.max(list, Math.ceil((list * (100 + reserve)) / 100));
  }
  const fee = Math.round(list * feePct);
  const profit = list - fee - cost;
  return {
    listCents: list,
    feeCents: fee,
    costCents: cost,
    retailCents: Math.round(retail) || null,
    profitCents: profit,
    returnReservePct: reserve,
    ok: profit >= 500 && list > 0,
  };
}

export async function getFeesEstimate(storeId, { asin, priceCents, isAmazonFulfilled = false }) {
  try {
    const body = {
      FeesEstimateRequest: {
        MarketplaceId: marketplaceId(),
        IsAmazonFulfilled: isAmazonFulfilled,
        PriceToEstimateFees: {
          ListingPrice: { CurrencyCode: "USD", Amount: (Number(priceCents) / 100).toFixed(2) },
        },
        Identifier: `sku-${asin || "x"}-${priceCents}`,
        OptionalFulfillmentProgram: undefined,
      },
    };
    const path = asin
      ? `/products/fees/v0/items/${encodeURIComponent(asin)}/feesEstimate`
      : null;
    if (!path) return { feeCents: amazonReferralFeeCents(priceCents), source: "pct_fallback" };
    const json = await spapiFetch(storeId, "POST", path, body);
    const total =
      json?.payload?.FeesEstimateResult?.FeesEstimate?.TotalFeesEstimate?.Amount ??
      json?.FeesEstimateResult?.FeesEstimate?.TotalFeesEstimate?.Amount;
    if (total != null) return { feeCents: Math.round(Number(total) * 100), source: "product_fees" };
  } catch {
    /* fall through */
  }
  return { feeCents: amazonReferralFeeCents(priceCents), source: "pct_fallback" };
}

export async function searchCatalogAsin(storeId, unit) {
  const mp = marketplaceId();
  const upc = String(unit.upc || unit.listing_specs?.gtin || unit.listing_specs?.upc || "").replace(/\D/g, "");
  const asinHint = String(unit.listing_specs?.asin || "").trim().toUpperCase();
  if (/^B0[A-Z0-9]{8}$/i.test(asinHint)) {
    return { asin: asinHint, title: unit.title || null, source: "unit_asin", confidence: "high" };
  }
  const identifiers = [];
  if (upc.length >= 12) identifiers.push(`UPC=${upc}`);
  const queries = [];
  if (identifiers.length) {
    queries.push(
      `/catalog/2022-04-01/items?marketplaceIds=${mp}&identifiers=${encodeURIComponent(upc)}&identifiersType=UPC&includedData=summaries,identifiers&pageSize=5`,
    );
  }
  const brand = String(unit.brand || "").trim();
  const model = String(unit.model || "").trim();
  const title = String(unit.title || "").trim();
  const keywords = [brand, model].filter(Boolean).join(" ") || title.slice(0, 80);
  if (keywords) {
    queries.push(
      `/catalog/2022-04-01/items?marketplaceIds=${mp}&keywords=${encodeURIComponent(keywords)}&includedData=summaries&pageSize=5`,
    );
  }
  for (const path of queries) {
    try {
      const json = await spapiFetch(storeId, "GET", path);
      const items = json?.items || json?.payload?.items || [];
      const first = items[0];
      const asin = first?.asin;
      const summary = first?.summaries?.[0] || {};
      if (asin) {
        return {
          asin,
          title: summary.itemName || summary.item_name || null,
          brand: summary.brand || null,
          source: path.includes("identifiersType") ? "upc" : "keywords",
          confidence: path.includes("identifiersType") ? "high" : "medium",
          alternatives: items.slice(1, 5).map((it) => ({
            asin: it.asin,
            title: it.summaries?.[0]?.itemName || null,
          })),
        };
      }
    } catch (e) {
      if (/Unauthorized|403|Access/.test(String(e.message))) throw e;
    }
  }
  return { asin: null, title: null, source: "none", confidence: "none", alternatives: [] };
}

// ---------------------------------------------------------------------------
// UPC → catalog detail + current price (read-only; used by upc-lookup)
// ---------------------------------------------------------------------------

const LENGTH_TO_IN = { inches: 1, inch: 1, in: 1, feet: 12, foot: 12, ft: 12, centimeters: 1 / 2.54, centimeter: 1 / 2.54, cm: 1 / 2.54, millimeters: 1 / 25.4, millimeter: 1 / 25.4, mm: 1 / 25.4, meters: 100 / 2.54, meter: 100 / 2.54, m: 100 / 2.54 };
const WEIGHT_TO_LB = { pounds: 1, pound: 1, lb: 1, lbs: 1, ounces: 1 / 16, ounce: 1 / 16, oz: 1 / 16, grams: 0.00220462, gram: 0.00220462, g: 0.00220462, kilograms: 2.20462, kilogram: 2.20462, kg: 2.20462 };

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toInches(m) {
  const v = Number(m?.value);
  const f = LENGTH_TO_IN[String(m?.unit || "").toLowerCase()];
  return Number.isFinite(v) && v > 0 && f ? round2(v * f) : null;
}

function toPounds(m) {
  const v = Number(m?.value);
  const f = WEIGHT_TO_LB[String(m?.unit || "").toLowerCase()];
  return Number.isFinite(v) && v > 0 && f ? round2(v * f) : null;
}

/** First marketplace-matching value of a catalog `attributes` entry (they are arrays of {value, marketplace_id}). */
function attrValue(attributes, name) {
  const arr = attributes?.[name];
  if (!Array.isArray(arr) || !arr.length) return null;
  const mp = marketplaceId();
  return arr.find((a) => a?.marketplace_id === mp) || arr[0];
}

function attrString(attributes, name) {
  const v = attrValue(attributes, name)?.value;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function forMarketplace(list) {
  if (!Array.isArray(list)) return null;
  return list.find((x) => x?.marketplaceId === marketplaceId()) || list[0] || null;
}

function emptyDims() {
  return { length_in: null, width_in: null, height_in: null, weight_lb: null };
}

function dimsFrom(measures, weight) {
  return {
    length_in: toInches(measures?.length),
    width_in: toInches(measures?.width),
    height_in: toInches(measures?.height),
    weight_lb: toPounds(weight ?? measures?.weight),
  };
}

function fillDims(primary, fallback) {
  const out = { ...emptyDims() };
  for (const k of Object.keys(out)) out[k] = primary?.[k] ?? fallback?.[k] ?? null;
  return out;
}

/** Largest image per variant (MAIN first, then PT01…), as URLs. */
export function pickLargestImages(imageSets) {
  const set = forMarketplace(imageSets);
  const byVariant = new Map();
  for (const img of set?.images || []) {
    if (!img?.link) continue;
    const key = img.variant || "UNK";
    const area = (Number(img.width) || 0) * (Number(img.height) || 0);
    const cur = byVariant.get(key);
    if (!cur || area > cur.area) byVariant.set(key, { link: img.link, area });
  }
  const order = (v) => (v === "MAIN" ? -1 : v === "UNK" ? 999 : Number((v.match(/\d+/) || [500])[0]));
  return [...byVariant.entries()].sort((a, b) => order(a[0]) - order(b[0])).map(([, v]) => v.link);
}

/**
 * Amazon catalog attribute keys that map cleanly to listing "item specifics"
 * (flavor, form, size, etc.). Values are taken only when Amazon returned them.
 */
const SPECIFIC_ATTR_KEYS = [
  ["flavor", "Flavor"],
  ["scent", "Scent"],
  ["color", "Color"],
  ["size", "Size"],
  ["style", "Style"],
  ["item_form", "Item Form"],
  ["form_factor", "Item Form"],
  ["material_type", "Material"],
  ["material", "Material"],
  ["special_feature", "Special Feature"],
  ["special_features", "Special Feature"],
  ["product_benefit", "Product Benefit"],
  ["diet_type", "Diet Type"],
  ["target_gender", "Target Gender"],
  ["age_range_description", "Age Range"],
  ["unit_count", "Unit Count"],
  ["number_of_items", "Number of Items"],
  ["pattern", "Pattern"],
  ["capacity", "Capacity"],
  ["wattage", "Wattage"],
  ["voltage", "Voltage"],
  ["fragrance", "Fragrance"],
  ["hair_type", "Hair Type"],
  ["skin_type", "Skin Type"],
  ["occasion_type", "Occasion"],
  ["sport_type", "Sport"],
  ["department", "Department"],
];

/** Pull named specifics from catalog attributes. Never invents values. */
export function extractCatalogAspects(attributes) {
  const out = {};
  if (!attributes || typeof attributes !== "object") return out;
  for (const [key, label] of SPECIFIC_ATTR_KEYS) {
    if (out[label]) continue;
    const raw = attrValue(attributes, key);
    if (raw == null) continue;
    let value = null;
    if (typeof raw.value === "string" && raw.value.trim()) value = raw.value.trim();
    else if (typeof raw.value === "number" && Number.isFinite(raw.value)) {
      const unit = typeof raw.unit === "string" && raw.unit.trim() ? ` ${raw.unit.trim()}` : "";
      value = `${raw.value}${unit}`;
    } else if (Array.isArray(raw.value)) {
      value = raw.value.map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim())).filter(Boolean).join(", ") || null;
    } else if (raw.value && typeof raw.value === "object" && typeof raw.value.value === "string") {
      value = raw.value.value.trim() || null;
    }
    if (value) out[label] = value;
  }
  return out;
}

/** "Flavor: Berry · Item Form: Gummy" — empty string when nothing real. */
export function formatAspectsLine(aspects) {
  if (!aspects || typeof aspects !== "object") return "";
  return Object.entries(aspects)
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([k, v]) => `${k}: ${String(v).trim()}`)
    .join(" · ");
}

/** Reject retailer item numbers / bare digit codes masquerading as model. */
export function usableModelNumber(raw) {
  const m = String(raw ?? "").trim();
  if (!m) return null;
  if (/^\d{4,}$/.test(m)) return null;
  if (/^(itm|art|sku|dpci|tcin)[\s#:-]?\d+/i.test(m)) return null;
  return m;
}

/**
 * Human-facing item specifics for Receive: real MPN, else aspect line, else a short
 * pack/variant phrase from the title (never a bare digit code).
 */
export function itemSpecificsFromLookup({ model, aspects, title, brand } = {}) {
  const mpn = usableModelNumber(model);
  if (mpn) return mpn;
  const aspectsLine = formatAspectsLine(aspects);
  if (aspectsLine) return aspectsLine;
  return variantFromTitle(title, brand);
}

/** "Oral-B Replacement Brush Heads, 10 Count" → "Replacement Brush Heads, 10 Count" */
export function variantFromTitle(title, brand) {
  let t = String(title || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const b = String(brand || "").trim();
  if (b && t.toLowerCase().startsWith(b.toLowerCase())) {
    t = t.slice(b.length).replace(/^[\s,:\-|–—]+/, "").trim();
  }
  // Prefer a pack/size clause when present (allow commas so "Brush Heads, 10 Count" keeps the product words).
  const pack = t.match(
    /(.{0,80}\b\d+\s*(?:-?\s*)?(?:count|ct|pack|pk|heads?|refills?|pieces?|pcs?|oz|fl\s*oz|ml|g)\b[^|/]{0,40})/i,
  );
  if (pack) return pack[1].trim().replace(/^[\s,:\-|–—]+/, "");
  // Otherwise first clause, capped.
  return t.split(/[|/]/)[0].trim().slice(0, 80);
}

/** Parse one SP-API Catalog Items 2022-04-01 item into Floor's flat shape. Never invents fields. */
export function parseCatalogItem(item) {
  if (!item?.asin) return null;
  const attrs = item.attributes || {};
  const summary = forMarketplace(item.summaries) || {};
  const dim = forMarketplace(item.dimensions) || {};
  const features = (Array.isArray(attrs.bullet_point) ? attrs.bullet_point : [])
    .filter((b) => !b?.marketplace_id || b.marketplace_id === marketplaceId())
    .map((b) => (typeof b?.value === "string" ? b.value.trim() : ""))
    .filter(Boolean);
  const pkgFromDim = dimsFrom(dim.package);
  const itemFromDim = dimsFrom(dim.item);
  const pkgAttr = attrValue(attrs, "item_package_dimensions");
  const itemAttr = attrValue(attrs, "item_dimensions");
  const pkg = fillDims(pkgFromDim, dimsFrom(pkgAttr, attrValue(attrs, "item_package_weight")));
  const itemDims = fillDims(itemFromDim, dimsFrom(itemAttr, attrValue(attrs, "item_weight")));
  const productType = forMarketplace(item.productTypes)?.productType || null;
  const listPrice = attrValue(attrs, "list_price");
  const listAmount = Number(listPrice?.value ?? listPrice?.value_with_tax);
  const aspects = extractCatalogAspects(attrs);
  // Amazon often puts retailer ITM/ART/SKU-style digit strings in modelNumber — those are not
  // usable as Floor "item specifics" (e.g. Oral-B "4610583"). Keep a real MPN; drop pure digits.
  const rawModel =
    summary.modelNumber || attrString(attrs, "model_number") || summary.partNumber || attrString(attrs, "part_number");
  const model = usableModelNumber(rawModel);
  return {
    asin: item.asin,
    title: summary.itemName || attrString(attrs, "item_name"),
    brand: summary.brand || attrString(attrs, "brand"),
    model,
    part_number: summary.partNumber || attrString(attrs, "part_number"),
    manufacturer: summary.manufacturer || attrString(attrs, "manufacturer"),
    description: attrString(attrs, "product_description"),
    features,
    aspects,
    package: pkg,
    item: itemDims,
    images: pickLargestImages(item.images),
    category: summary.browseClassification?.displayName || productType,
    product_type: productType,
    msrp_cents: Number.isFinite(listAmount) && listAmount > 0 ? Math.round(listAmount * 100) : null,
    identifiers: (forMarketplace(item.identifiers)?.identifiers || []).map((i) => ({ type: i.identifierType, value: i.identifier })),
  };
}

/**
 * Catalog lookup by barcode. Returns { found, item (parsed), alternatives }.
 * @param {string} identifierType UPC | EAN | GTIN
 */
export async function catalogItemByIdentifier(storeId, identifierType, value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) throw new Error("identifier_required");
  const path =
    `/catalog/2022-04-01/items?marketplaceIds=${marketplaceId()}` +
    `&identifiers=${encodeURIComponent(digits)}&identifiersType=${encodeURIComponent(identifierType)}` +
    `&includedData=summaries,attributes,images,dimensions,identifiers,productTypes&pageSize=5`;
  const json = await spapiFetch(storeId, "GET", path);
  const items = json?.items || json?.payload?.items || [];
  const parsed = items.map(parseCatalogItem).filter(Boolean);
  return {
    found: parsed.length > 0,
    item: parsed[0] || null,
    alternatives: parsed.slice(1).map((p) => ({ asin: p.asin, title: p.title })),
  };
}

/** GET /catalog/2022-04-01/items by UPC-A (12 digits). */
export function catalogItemByUpc(storeId, upcA) {
  return catalogItemByIdentifier(storeId, "UPC", upcA);
}

function moneyCents(m) {
  const n = Number(m?.Amount);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

function isPricingRateLimited(err) {
  return err?.status === 429 || /QuotaExceeded|Rate exceeded|Too Many Requests/i.test(String(err?.message || err?.code || ""));
}

/**
 * Current listing price (cents) for an ASIN. Needs the Pricing role on the SP-API app.
 * Tries getItemOffers (buy box → lowest new → lowest offer), then getPricing.
 * On 429: one polite retry, then return price_pending (never throws — catalog lookup must still succeed).
 * @returns {{ price_cents: number|null, source: string|null, as_of: string, price_pending?: boolean, raw_error?: string }}
 */
export async function competitivePriceByAsin(storeId, asin) {
  const id = String(asin || "").trim().toUpperCase();
  const as_of = new Date().toISOString();
  if (!id) return { price_cents: null, source: null, as_of, raw_error: "asin_required" };
  const mp = marketplaceId();
  let firstError = null;
  let rateLimited = false;

  async function tryOffers() {
    const json = await spapiFetch(
      storeId,
      "GET",
      `/products/pricing/v0/items/${encodeURIComponent(id)}/offers?MarketplaceId=${mp}&ItemCondition=New&CustomerType=Consumer`,
    );
    const payload = json?.payload || json || {};
    const summary = payload.Summary || {};
    const isNew = (x) => /^new$/i.test(String(x?.condition || x?.Condition || ""));
    const buybox = (summary.BuyBoxPrices || []).find(isNew) || (summary.BuyBoxPrices || [])[0];
    let cents = moneyCents(buybox?.ListingPrice);
    if (cents) return { price_cents: cents, source: "buybox", as_of };
    const lows = (summary.LowestPrices || []).filter(isNew).map((l) => moneyCents(l.ListingPrice)).filter(Boolean);
    if (lows.length) return { price_cents: Math.min(...lows), source: "lowest_new", as_of };
    const offers = (payload.Offers || []).map((o) => moneyCents(o.ListingPrice)).filter(Boolean);
    cents = offers.length ? Math.min(...offers) : null;
    if (cents) return { price_cents: cents, source: "lowest_offer", as_of };
    return null;
  }

  async function tryPricing() {
    const json = await spapiFetch(
      storeId,
      "GET",
      `/products/pricing/v0/price?MarketplaceId=${mp}&Asins=${encodeURIComponent(id)}&ItemType=Asin&ItemCondition=New&CustomerType=Consumer`,
    );
    const rows = json?.payload || [];
    const product = (Array.isArray(rows) ? rows[0] : rows)?.Product || {};
    const comp = (product.CompetitivePricing?.CompetitivePrices || [])[0];
    let cents = moneyCents(comp?.Price?.ListingPrice);
    if (cents) return { price_cents: cents, source: "competitive_pricing", as_of };
    const offerPrices = (product.Offers || []).map((o) => moneyCents(o.BuyingPrice?.ListingPrice)).filter(Boolean);
    cents = offerPrices.length ? Math.min(...offerPrices) : null;
    if (cents) return { price_cents: cents, source: "pricing_offer", as_of };
    return null;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const hit = await tryOffers();
      if (hit) return hit;
      break;
    } catch (e) {
      firstError = e;
      if (e?.status === 403 || e?.status === 401 || /not_connected|Missing env/i.test(String(e?.message))) {
        return { price_cents: null, source: null, as_of, raw_error: String(e.message).slice(0, 300) };
      }
      if (isPricingRateLimited(e)) {
        rateLimited = true;
        if (attempt === 0) {
          await sleep(900 + Math.floor(Math.random() * 500));
          continue;
        }
      }
      break;
    }
  }

  if (!rateLimited) {
    try {
      const hit = await tryPricing();
      if (hit) return hit;
    } catch (e) {
      firstError = firstError || e;
      if (isPricingRateLimited(e)) rateLimited = true;
    }
  }

  if (rateLimited) {
    return {
      price_cents: null,
      source: null,
      as_of,
      price_pending: true,
      raw_error: "amazon_pricing_rate_limited",
    };
  }

  return {
    price_cents: null,
    source: null,
    as_of,
    ...(firstError ? { raw_error: String(firstError.message || firstError).slice(0, 300) } : {}),
  };
}

/**
 * Create FBM offer against existing ASIN. Never uploads images.
 */
export async function listAmazonOffer(storeId, kit) {
  if (!amazonListingEnabled()) {
    return {
      ok: false,
      reason: "amazon_listing_disabled",
      message: "Set AMAZON_LISTING_ENABLED=1 in Netlify when ready to create offers.",
    };
  }
  try { await assertBundlePush(storeId, kit?.sku || kit?.unit?.sku, 'amazon'); }
  catch (error) { return { ok: false, reason: 'bundle_gate', message: error.message }; }
  const unit = kit?.unit || kit;
  const sku = String(unit.sku || kit.sku || "");
  const never = amazonNeverListReason(unit);
  if (never) return { ok: false, reason: "never_list", message: never };

  const cond = amazonConditionFromUnit(unit);
  if (!cond.confident || !cond.amazon) {
    return { ok: false, reason: "condition_unclear", message: cond.reason || "Confirm condition" };
  }

  let asin = kit.asin || unit.listing_specs?.asin || null;
  if (!asin) {
    const match = await searchCatalogAsin(storeId, unit);
    asin = match.asin;
    if (!asin) {
      return {
        ok: false,
        reason: "needs_asin",
        message: "No catalog ASIN match — set ASIN manually (do not create a new product page).",
        match,
      };
    }
  }

  const gating = await amazonGatingCheck(storeId, { brand: unit.brand, category: unit.category, asin });
  if (!gating.ok) return { ok: false, reason: gating.reason, message: gating.message || "Gated" };

  let returnReservePct = 0;
  try {
    const { reservePctForChannel } = await import("./returns.mjs");
    returnReservePct = await reservePctForChannel(storeId, "amazon");
  } catch {
    returnReservePct = 0;
  }
  const priceHint = suggestAmazonPriceCents(unit, 0.15, returnReservePct);
  const fees = await getFeesEstimate(storeId, { asin, priceCents: kit.priceCents || priceHint.listCents });
  const feePct = fees.feeCents / Math.max(kit.priceCents || priceHint.listCents, 1);
  const price = suggestAmazonPriceCents(unit, feePct || 0.15, returnReservePct);
  const listCents = kit.priceCents || price.listCents;
  if (listCents - fees.feeCents - price.costCents < 500) {
    return {
      ok: false,
      reason: "under_floor",
      message: `Price $${(listCents / 100).toFixed(2)} would net under $5 after fees/cost.`,
      listCents,
      fees,
    };
  }

  const sid = sellerId();
  if (!sid) return { ok: false, reason: "missing_seller_id", message: "AMAZON_SELLER_ID not set" };

  const restr = await checkListingRestrictions(storeId, { asin, sellerId: sid, conditionType: cond.amazon });
  if (restr.blocked) {
    return {
      ok: false,
      reason: restr.reason || "gated_restriction",
      message: restr.message,
      restr: restr.raw,
    };
  }

  const productType = kit.productType || "PRODUCT";
  const payload = {
    productType,
    requirements: "LISTING_OFFER_ONLY",
    attributes: {
      condition_type: [{ value: cond.amazon, marketplace_id: marketplaceId() }],
      condition_note: [{ value: cond.note.slice(0, 1000), marketplace_id: marketplaceId() }],
      merchant_suggested_asin: [{ value: asin, marketplace_id: marketplaceId() }],
      purchasable_offer: [
        {
          currency: "USD",
          our_price: [{ schedule: [{ value_with_tax: Number((listCents / 100).toFixed(2)) }] }],
          marketplace_id: marketplaceId(),
        },
      ],
      fulfillment_availability: [
        {
          fulfillment_channel_code: "DEFAULT",
          quantity: 1,
          marketplace_id: marketplaceId(),
        },
      ],
    },
  };

  const path = `/listings/2021-08-01/items/${encodeURIComponent(sid)}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId()}`;
  const json = await spapiFetch(storeId, "PUT", path, payload);

  const sb = serviceClient();
  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku,
      channel: "amazon",
      status: "listed",
      listing_id: asin,
      offer_id: productType,
      listed_at: new Date().toISOString(),
    },
    { onConflict: "store_id,sku,channel" },
  );

  return {
    ok: true,
    asin,
    sku,
    listCents,
    feeCents: fees.feeCents,
    condition: cond.amazon,
    conditionNote: cond.note,
    submission: json,
  };
}

export async function amazonGatingCheck(_storeId, { brand, category, asin }) {
  const gated = (process.env.AMAZON_GATED_BRANDS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const b = String(brand || "").toLowerCase();
  if (b && gated.some((g) => b.includes(g))) {
    return { ok: false, reason: "gated_brand", message: `Brand "${brand}" is in AMAZON_GATED_BRANDS`, brand };
  }
  void category;
  void asin;
  return { ok: true };
}

/**
 * Listings Restrictions API — surface approval / not-eligible clearly (never silent).
 * Empty restrictions (or none matching condition) means eligible to list.
 */
export async function checkListingRestrictions(storeId, { asin, sellerId: sid, conditionType }) {
  const seller = sid || sellerId();
  if (!asin || !seller) {
    return {
      blocked: true,
      reason: "restrictions_incomplete",
      message: !asin
        ? "ASIN required before Amazon restrictions check."
        : "AMAZON_SELLER_ID not set — cannot check listing restrictions.",
      raw: null,
    };
  }
  const cond = conditionType || "new_new";
  try {
    const restr = await spapiFetch(
      storeId,
      "GET",
      `/listings/2021-08-01/restrictions?asin=${encodeURIComponent(asin)}&sellerId=${encodeURIComponent(seller)}&marketplaceIds=${marketplaceId()}&conditionType=${encodeURIComponent(cond)}`,
    );
    const rows = restr?.restrictions || [];
    const reasons = [];
    for (const r of rows) {
      for (const reason of r?.reasons || []) {
        const code = String(reason?.reasonCode || reason?.code || "").toUpperCase();
        const msg = String(reason?.message || "").trim();
        if (code || msg) reasons.push({ code, message: msg });
      }
      // Some payloads only nest codes in the restriction object itself
      const blob = JSON.stringify(r);
      if (/APPROVAL_REQUIRED/i.test(blob) && !reasons.some((x) => x.code === "APPROVAL_REQUIRED")) {
        reasons.push({ code: "APPROVAL_REQUIRED", message: "Seller Central approval required for this ASIN/condition." });
      }
      if (/NOT_ELIGIBLE/i.test(blob) && !reasons.some((x) => x.code === "NOT_ELIGIBLE")) {
        reasons.push({ code: "NOT_ELIGIBLE", message: "Not eligible to list this ASIN/condition." });
      }
    }
    const approval = reasons.find((x) => /APPROVAL_REQUIRED/i.test(x.code));
    const ineligible = reasons.find((x) => /NOT_ELIGIBLE/i.test(x.code));
    if (ineligible || approval || reasons.some((x) => /NOT_ELIGIBLE|APPROVAL_REQUIRED/i.test(x.code + x.message))) {
      const primary = ineligible || approval || reasons[0];
      const label = primary?.code === "APPROVAL_REQUIRED"
        ? "Amazon approval required"
        : primary?.code === "NOT_ELIGIBLE"
          ? "Amazon listing not eligible"
          : "Amazon listing restriction";
      const detail = primary?.message || reasons.map((x) => x.message || x.code).filter(Boolean).join("; ");
      return {
        blocked: true,
        reason: primary?.code === "APPROVAL_REQUIRED" ? "approval_required" : "gated_restriction",
        message: detail ? `${label}: ${detail}` : `${label} for ASIN ${asin} (${cond}). Approve in Seller Central or skip.`,
        codes: reasons.map((x) => x.code).filter(Boolean),
        raw: restr,
      };
    }
    return { blocked: false, reason: null, message: null, raw: restr };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 280);
    // Auth / role gaps must not look like "ready to list"
    if (/Unauthorized|403|Access|Forbidden|amazon_not_connected|Missing env/i.test(msg)) {
      return {
        blocked: true,
        reason: "restrictions_check_failed",
        message: `Could not verify Amazon listing restrictions (${msg}). Fix SP-API access, then Retry / prepare.`,
        raw: e?.body || null,
      };
    }
    return {
      blocked: true,
      reason: "restrictions_check_failed",
      message: `Amazon restrictions check failed: ${msg}. Retry after Seller Central / API recovers.`,
      raw: e?.body || null,
    };
  }
}

export async function zeroAmazonQuantityForSku(storeId, sku) {
  const sb = serviceClient();
  const { data: listing } = await sb
    .from("listings")
    .select("*")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "amazon")
    .maybeSingle();
  if (!listing || listing.status !== "listed") {
    await sb
      .from("delist_tasks")
      .update({ completed_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", sku)
      .eq("channel", "amazon")
      .is("completed_at", null);
    return { skipped: true, reason: "not_listed" };
  }
  try {
    await spapiFetch(
      storeId,
      "PATCH",
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId() || "SELLER")}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId()}`,
      {
        productType: listing.offer_id || "PRODUCT",
        patches: [
          {
            op: "replace",
            path: "/attributes/fulfillment_availability",
            value: [{ fulfillment_channel_code: "DEFAULT", quantity: 0 }],
          },
        ],
      },
    );
  } catch (err) {
    if (!/amazon_not_connected|Missing env/i.test(String(err.message || err))) {
      console.log("amazon_zero_qty_error", JSON.stringify({ sku, error: String(err.message || err).slice(0, 200) }));
    }
  }
  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku,
      channel: "amazon",
      status: "delisted",
      listing_id: listing.listing_id ?? null,
      offer_id: listing.offer_id ?? null,
      delisted_at: new Date().toISOString(),
    },
    { onConflict: "store_id,sku,channel" },
  );
  await sb
    .from("delist_tasks")
    .update({ completed_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "amazon")
    .is("completed_at", null);
  return { ok: true, sku };
}

/**
 * Push Floor availability onto an Amazon offer SKU (seller SKU / listing SKU).
 * Quantity 1 when the Floor unit is available/reserved; 0 otherwise.
 */
export async function syncAmazonOfferQuantity(storeId, offerSku) {
  const sku = String(offerSku || "").trim();
  if (!sku) return { ok: false, reason: "offer_sku_required" };
  const sb = serviceClient();
  const { data: listing } = await sb
    .from("listings")
    .select("*")
    .eq("store_id", storeId)
    .eq("channel", "amazon")
    .or(`sku.eq.${sku},listing_id.eq.${sku},offer_id.eq.${sku}`)
    .maybeSingle();
  const floorSku = listing?.sku || sku;
  const { data: unit } = await sb
    .from("units")
    .select("sku,state")
    .eq("store_id", storeId)
    .eq("sku", floorSku)
    .maybeSingle();
  const qty = unit && (unit.state === "available" || unit.state === "reserved") ? 1 : 0;
  if (!listing || listing.status !== "listed") {
    if (qty === 0) return { ok: true, sku: floorSku, offerSku: sku, quantity: 0, skipped: "not_listed" };
    return { ok: false, reason: "not_listed", sku: floorSku, offerSku: sku };
  }
  if (qty === 0) {
    return { ...(await zeroAmazonQuantityForSku(storeId, floorSku)), quantity: 0, offerSku: sku };
  }
  try {
    await spapiFetch(
      storeId,
      "PATCH",
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId() || "SELLER")}/${encodeURIComponent(listing.listing_id || sku)}?marketplaceIds=${marketplaceId()}`,
      {
        productType: listing.offer_id || "PRODUCT",
        patches: [
          {
            op: "replace",
            path: "/attributes/fulfillment_availability",
            value: [{ fulfillment_channel_code: "DEFAULT", quantity: qty }],
          },
        ],
      },
    );
  } catch (err) {
    return { ok: false, reason: "patch_failed", message: String(err.message || err).slice(0, 300), sku: floorSku, offerSku: sku };
  }
  await sb
    .from("amazon_list_items")
    .update({ qty_listed: qty, updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", floorSku);
  return { ok: true, sku: floorSku, offerSku: sku, quantity: qty };
}

/** Resolve Floor SKU → Amazon offer and sync quantity from unit state. */
export async function syncAmazonOfferForFloorSku(storeId, sku) {
  const floorSku = String(sku || "").trim();
  if (!floorSku) return { ok: false, reason: "sku_required" };
  const sb = serviceClient();
  const { data: row } = await sb
    .from("amazon_list_items")
    .select("offer_sku,listing_sku,sku")
    .eq("store_id", storeId)
    .eq("sku", floorSku)
    .maybeSingle();
  const offerSku = row?.offer_sku || row?.listing_sku || floorSku;
  return syncAmazonOfferQuantity(storeId, offerSku);
}

async function alertDoubleSellAmazon(sku, orderId, detail) {
  const to = process.env.AMAZON_DOUBLE_SELL_EMAIL || "pgg124@gmail.com";
  if (!gmailConfigured()) {
    console.log("amazon_double_sell_no_gmail_smtp", JSON.stringify({ sku, orderId }));
    return;
  }
  const text = [
    `URGENT: Amazon order ${orderId} for SKU ${sku} but Floor unit is not sellable (already sold elsewhere).`,
    `Cancel the Amazon order in Seller Central yourself.`,
    `Detail: ${JSON.stringify(detail).slice(0, 500)}`,
    `(No buyer PII is included — we do not have restricted order roles.)`,
  ].join("\n");
  await sendInternalAlert({
    to,
    subject: `URGENT: double sale risk SKU ${sku} on Amazon`,
    text,
  }).catch(() => undefined);
}

function orderItemPriceCents(order, item) {
  const money = item?.ItemPrice?.Amount ?? order?.OrderTotal?.Amount;
  return Math.round(Number(money || 0) * 100);
}

function orderShippingCents(_order, item) {
  const money = item?.ShippingPrice?.Amount ?? 0;
  return Math.round(Number(money || 0) * 100);
}

function orderTaxCents(item) {
  const money = item?.ItemTax?.Amount ?? 0;
  return Math.round(Number(money || 0) * 100);
}

export async function ingestAmazonOrder(storeId, order) {
  const orderId = order?.AmazonOrderId;
  const items = order?.OrderItems || order?.orderItems || [];
  const item = items[0];
  const sku = item?.SellerSKU || item?.sellerSku;
  if (!orderId || !sku) return { skipped: true };

  const sb = serviceClient();
  const seen = await sb
    .from("channel_orders")
    .select("order_id")
    .eq("store_id", storeId)
    .eq("provider", "amazon")
    .eq("order_id", orderId)
    .maybeSingle();
  if (seen.data) return { skipped: true, sku, orderId };

  const itemCents = orderItemPriceCents(order, item);
  const shipCents = orderShippingCents(order, item);
  const taxCents = orderTaxCents(item);
  const feeCents = amazonReferralFeeCents(itemCents);

  const { data: sale, error } = await sb.rpc("finalize_sale", {
    p_sku: String(sku),
    p_channel: "amazon",
    p_price_cents: itemCents,
    p_payment_method: "amazon",
    p_payment_id: `amazon:${orderId}`,
    p_note: `Amazon order (referral~$${(feeCents / 100).toFixed(2)}; tax remitted by Amazon)`,
    p_tax_cents: taxCents,
    p_approval_id: null,
  });
  if (error) {
    if (/unit_not_sellable|duplicate key|23505/i.test(error.message)) {
      await alertDoubleSellAmazon(sku, orderId, { error: error.message });
      await zeroAmazonQuantityForSku(storeId, sku).catch(() => undefined);
      const { withdrawSku } = await import("./ebay.mjs");
      await withdrawSku(storeId, sku).catch(() => undefined);
      return { ok: false, doubleSell: true, sku, orderId, error: error.message };
    }
    throw new Error(error.message);
  }

  await sb.from("channel_orders").insert({
    store_id: storeId,
    provider: "amazon",
    order_id: orderId,
    sku: String(sku),
    sale_id: sale?.id ?? null,
    item_cents: itemCents,
  });

  // No buyer PII — restricted roles not granted
  await sb.from("web_orders").insert({
    store_id: storeId,
    sku: String(sku),
    sale_id: sale?.id ?? null,
    status: "paid",
    fulfillment: "ship",
    buyer_name: null,
    buyer_email: null,
    buyer_phone: null,
    ship_line1: null,
    ship_line2: null,
    ship_city: null,
    ship_region: null,
    ship_postal: null,
    ship_country: "US",
    item_cents: itemCents,
    shipping_cents: shipCents,
    tax_cents: taxCents,
    total_cents: itemCents + shipCents + taxCents,
    marketplace_fee_cents: feeCents,
    tax_remitted_by: "amazon",
    payment_id: `amazon:${orderId}`,
    order_no: orderId,
    paid_at: new Date().toISOString(),
    payment_env: "production",
    channel: "amazon",
    match_status: "matched",
    marketplace_title: String(item?.Title || "").slice(0, 250) || null,
  });

  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku: String(sku),
      channel: "amazon",
      status: "delisted",
      delisted_at: new Date().toISOString(),
    },
    { onConflict: "store_id,sku,channel" },
  );
  try {
    await sb
      .from("amazon_list_items")
      .update({ status: "sold", updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", String(sku));
  } catch {
    /* optional queue row */
  }

  const { withdrawSku } = await import("./ebay.mjs");
  await withdrawSku(storeId, String(sku)).catch(() => undefined);
  await zeroAmazonQuantityForSku(storeId, String(sku)).catch(() => undefined);

  return { sku, orderId, saleId: sale?.id, feeCents, taxCents, shipCents };
}

export async function pollAmazonOrders(storeId) {
  // Day-one lookback (override with AMAZON_ORDERS_LOOKBACK_DAYS). Prior 3-day window missed history.
  const days = Math.max(1, Number(process.env.AMAZON_ORDERS_LOOKBACK_DAYS) || 90);
  const createdAfter = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const path =
    `/orders/v0/orders?MarketplaceIds=${marketplaceId()}` +
    `&CreatedAfter=${encodeURIComponent(createdAfter)}` +
    `&OrderStatuses=Pending,Unshipped,PartiallyShipped,Shipped,Canceled,Unfulfillable`;
  let data;
  try {
    data = await spapiFetch(storeId, "GET", path);
  } catch (err) {
    return { error: String(err.message || err), results: [] };
  }
  const orders = data?.payload?.Orders || data?.Orders || [];
  const results = [];
  for (const order of orders) {
    try {
      let full = order;
      if (!order.OrderItems) {
        const items = await spapiFetch(
          storeId,
          "GET",
          `/orders/v0/orders/${encodeURIComponent(order.AmazonOrderId)}/orderItems`,
        );
        full = { ...order, OrderItems: items?.payload?.OrderItems || items?.OrderItems || [] };
      }
      results.push(await ingestAmazonOrder(storeId, full));
    } catch (err) {
      results.push({
        orderId: order.AmazonOrderId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { results, count: orders.length };
}

/** Pull financial event groups (fees/refunds/payouts) — no PII. */
export async function pollAmazonFinances(storeId) {
  const postedAfter = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const path = `/finances/v0/financialEvents?PostedAfter=${encodeURIComponent(postedAfter)}`;
  let data;
  try {
    data = await spapiFetch(storeId, "GET", path);
  } catch (err) {
    return { error: String(err.message || err), inserted: 0 };
  }
  const events = data?.payload?.FinancialEvents || data?.FinancialEvents || {};
  const sb = serviceClient();
  let inserted = 0;
  const shipments = events.ShipmentEventList || [];
  for (const ev of shipments) {
    const orderId = ev.AmazonOrderId || null;
    for (const item of ev.ShipmentItemList || []) {
      const sku = item.SellerSKU || null;
      const feeTotal = (item.ItemFeeList || []).reduce((n, f) => n + Math.round(Number(f.FeeAmount?.CurrencyAmount || 0) * 100), 0);
      const eventId = `ship-fee:${orderId}:${sku}:${feeTotal}`;
      const { error } = await sb.from("amazon_finance_events").upsert(
        {
          store_id: storeId,
          event_id: eventId,
          event_type: "shipment_fees",
          posted_at: ev.PostedDate || null,
          order_id: orderId,
          sku,
          amount_cents: -Math.abs(feeTotal),
          raw: { fees: item.ItemFeeList || [] },
        },
        { onConflict: "store_id,event_id" },
      );
      if (!error) inserted += 1;
      if (orderId && feeTotal) {
        try {
          await sb
            .from("web_orders")
            .update({ marketplace_fee_cents: Math.abs(feeTotal) })
            .eq("store_id", storeId)
            .eq("channel", "amazon")
            .eq("order_no", orderId);
        } catch {
          /* optional fee mirror */
        }
      }
    }
  }
  return { inserted, postedAfter };
}

/** Prepare queue row: validate, match ASIN, price — does not list. */
/** Cron/job entry: poll orders + finances + zero qty for sold-elsewhere units. */
export async function runAmazonSyncJob(storeIdHint = STORE_DEFAULT) {
  await ensureAmazonRefreshStored(storeIdHint || STORE_DEFAULT).catch(() => undefined);
  const sb = serviceClient();
  const { data: rows } = await sb
    .from("connections")
    .select("store_id")
    .eq("provider", "amazon")
    .eq("status", "connected");

  const storeIds = new Set((rows || []).map((r) => r.store_id));
  // Env refresh is a bootstrap fallback until encrypted connections row exists.
  if (storeIds.size === 0 && (process.env.AMAZON_REFRESH_TOKEN || storeIdHint)) {
    storeIds.add(storeIdHint || STORE_DEFAULT);
  }

  const out = [];
  for (const storeId of storeIds) {
    const orders = await pollAmazonOrders(storeId).catch((e) => ({
      error: String(e.message || e),
      results: [],
    }));
    const finances = await pollAmazonFinances(storeId).catch((e) => ({
      error: String(e.message || e),
      inserted: 0,
    }));

    const { data: soldListed } = await sb
      .from("listings")
      .select("sku")
      .eq("store_id", storeId)
      .eq("channel", "amazon")
      .eq("status", "listed");
    const skus = (soldListed || []).map((r) => r.sku);
    const zeros = [];
    if (skus.length) {
      const { data: units } = await sb
        .from("units")
        .select("sku, state")
        .eq("store_id", storeId)
        .in("sku", skus)
        .neq("state", "available");
      for (const u of units || []) {
        zeros.push(
          await zeroAmazonQuantityForSku(storeId, u.sku).catch((e) => ({
            sku: u.sku,
            error: String(e),
          })),
        );
      }
    }

    const { data: tasks } = await sb
      .from("delist_tasks")
      .select("sku")
      .eq("store_id", storeId)
      .eq("channel", "amazon")
      .is("completed_at", null)
      .limit(40);
    for (const t of tasks || []) {
      zeros.push(
        await zeroAmazonQuantityForSku(storeId, t.sku).catch((e) => ({
          sku: t.sku,
          error: String(e),
        })),
      );
    }

    out.push({ storeId, orders, finances, zeroed: zeros, listing_enabled: amazonListingEnabled() });
  }
  return { ok: true, stores: out.length, results: out };
}

export async function prepareAmazonQueueItem(storeId, sku) {
  const sb = serviceClient();
  const { data: unit, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) throw new Error(error.message);
  if (!unit) return { ok: false, status: "error", last_error: "unknown_sku" };
  if (unit.state !== "available") return { ok: false, status: "error", last_error: `unit_state_${unit.state}` };
  const never = amazonNeverListReason(unit);
  if (never) return { ok: false, status: "error", last_error: never };
  const { count: photos } = await sb
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("sku", sku);
  if (!photos) return { ok: false, status: "error", last_error: "no_photos" };
  if (!unit.ask_cents || unit.ask_cents <= 0) return { ok: false, status: "error", last_error: "no_price" };

  const cond = amazonConditionFromUnit(unit);
  if (!cond.confident) {
    return {
      ok: false,
      status: "needs_review",
      needs_review_reason: cond.reason,
      condition_code: null,
      condition_note: null,
    };
  }

  const match = await searchCatalogAsin(storeId, unit);
  let returnReservePct = 0;
  try {
    const { reservePctForChannel } = await import("./returns.mjs");
    returnReservePct = await reservePctForChannel(storeId, "amazon");
  } catch {
    returnReservePct = 0;
  }
  const price = suggestAmazonPriceCents(unit, 0.15, returnReservePct);
  let fee = { feeCents: amazonReferralFeeCents(price.listCents), source: "pct" };
  if (match.asin) {
    fee = await getFeesEstimate(storeId, { asin: match.asin, priceCents: price.listCents });
  }

  const gating = await amazonGatingCheck(storeId, {
    brand: unit.brand,
    category: unit.category,
    asin: match.asin,
  });
  if (!gating.ok) {
    const patch = {
      status: "needs_review",
      asin: match.asin,
      matched_title: match.title,
      amazon_price_cents: price.listCents,
      fee_estimate_cents: fee.feeCents,
      condition_code: cond.amazon,
      condition_note: cond.note,
      retail_cents: price.retailCents,
      cost_cents: price.costCents,
      needs_review_reason: gating.message || "Gated brand — approval needed in Seller Central",
      last_error: null,
    };
    await sb
      .from("amazon_list_items")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", sku);
    return { ok: false, ...patch, match, price, gating };
  }

  if (match.asin) {
    const restr = await checkListingRestrictions(storeId, {
      asin: match.asin,
      conditionType: cond.amazon,
    });
    if (restr.blocked) {
      const patch = {
        status: "needs_review",
        asin: match.asin,
        matched_title: match.title,
        amazon_price_cents: price.listCents,
        fee_estimate_cents: fee.feeCents,
        condition_code: cond.amazon,
        condition_note: cond.note,
        retail_cents: price.retailCents,
        cost_cents: price.costCents,
        needs_review_reason: restr.message,
        last_error: restr.reason === "restrictions_check_failed" ? restr.message : null,
      };
      await sb
        .from("amazon_list_items")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("store_id", storeId)
        .eq("sku", sku);
      return { ok: false, ...patch, match, price, restrictions: restr };
    }
  }

  // No catalog ASIN: run VALIDATION_PREVIEW create probe. GS1/brand mismatch → not_on_amazon.
  if (!match.asin) {
    try {
      const { createAmazonCatalogListing } = await import("./amazon-create.mjs");
      const preview = await createAmazonCatalogListing(storeId, sku, { mode: "VALIDATION_PREVIEW" });
      if (preview.gs1OrBrandBlocked || preview.autoMarkedNotOnAmazon) {
        const patchBlocked = {
          status: "not_on_amazon",
          asin: null,
          matched_title: null,
          amazon_price_cents: price.listCents,
          fee_estimate_cents: fee.feeCents,
          condition_code: cond.amazon,
          condition_note: cond.note,
          retail_cents: price.retailCents,
          cost_cents: price.costCents,
          needs_review_reason:
            "Not on Amazon — sell on other channels. UPC/brand not in Amazon GS1 brand records (create blocked).",
          last_error: (preview.errors || []).map((e) => e.message).filter(Boolean).join(" · ").slice(0, 500) || null,
        };
        await sb
          .from("amazon_list_items")
          .update({ ...patchBlocked, updated_at: new Date().toISOString() })
          .eq("store_id", storeId)
          .eq("sku", sku);
        return { ok: false, ...patchBlocked, match, price, createPreview: preview };
      }
      const patchCreate = {
        status: "needs_review",
        asin: null,
        matched_title: null,
        amazon_price_cents: price.listCents,
        fee_estimate_cents: fee.feeCents,
        condition_code: cond.amazon,
        condition_note: cond.note,
        retail_cents: price.retailCents,
        cost_cents: price.costCents,
        needs_review_reason: preview.ok
          ? "No ASIN — create-new VALIDATION_PREVIEW is clean. Review Create new listing, then submit (needs Amazon-hosted main image)."
          : `No ASIN — create preview has ${preview.errorCount || 0} error(s). Open Create new listing to fix attributes, or mark Not on Amazon.`,
        last_error: preview.ok
          ? null
          : (preview.errors || []).map((e) => e.message).filter(Boolean).join(" · ").slice(0, 500) || null,
      };
      await sb
        .from("amazon_list_items")
        .update({ ...patchCreate, updated_at: new Date().toISOString() })
        .eq("store_id", storeId)
        .eq("sku", sku);
      return { ok: false, ...patchCreate, match, price, createPreview: preview };
    } catch (e) {
      const patchFallback = {
        status: "needs_review",
        asin: null,
        matched_title: null,
        amazon_price_cents: price.listCents,
        fee_estimate_cents: fee.feeCents,
        condition_code: cond.amazon,
        condition_note: cond.note,
        retail_cents: price.retailCents,
        cost_cents: price.costCents,
        needs_review_reason: "No ASIN match — paste ASIN, try Create new listing, or mark Not on Amazon.",
        last_error: e instanceof Error ? e.message : String(e),
      };
      await sb
        .from("amazon_list_items")
        .update({ ...patchFallback, updated_at: new Date().toISOString() })
        .eq("store_id", storeId)
        .eq("sku", sku);
      return { ok: false, ...patchFallback, match, price };
    }
  }

  const patch = {
    status: "ready",
    asin: match.asin,
    matched_title: match.title,
    amazon_price_cents: price.listCents,
    fee_estimate_cents: fee.feeCents,
    condition_code: cond.amazon,
    condition_note: cond.note,
    retail_cents: price.retailCents,
    cost_cents: price.costCents,
    needs_review_reason: null,
    last_error: null,
  };
  await sb
    .from("amazon_list_items")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", sku);
  return { ok: true, ...patch, match, price, returnReservePct };
}
