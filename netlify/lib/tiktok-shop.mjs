/**
 * TikTok Shop Open API (US Custom app) connector.
 *
 * Env (Netlify):
 *   TIKTOK_SHOP_APP_KEY
 *   TIKTOK_SHOP_APP_SECRET
 *   TIKTOK_SHOP_SERVICE_ID   (optional; Partner Center Service ID for authorize URL)
 *   TIKTOK_SHOP_SHOP_ID
 *   TIKTOK_SHOP_API_BASE     (default https://open-api.tiktokglobalshop.com)
 *   TIKTOK_SHOP_AUTH_BASE    (default https://auth.tiktok-shops.com)
 *   TIKTOK_SHOP_FEE_PCT      (default 0.08 — US commission bake-in)
 *   TIKTOK_SHOP_LISTING_ENABLED=1 to allow live product push
 *
 * Tokens: encrypted in public.connections (provider='tiktok'), same pattern as Amazon.
 * OAuth redirect (register in Partner Center):
 *   https://inventoryobi.netlify.app/.netlify/functions/tiktok-oauth-callback
 *
 * Until APP_KEY + APP_SECRET (+ shop/token) exist, helpers no-op with clear errors.
 * Never invent live API success.
 */

import { createHmac } from "node:crypto";
import { assertBundlePush, bundleMainSku } from "./bundle-gate.mjs";
import {
  serviceClient,
  decryptSecret,
  encryptSecret,
} from "./server.mjs";
import { sendInternalAlert, gmailConfigured } from "./mail.mjs";
import { ingestReturnRow, reservePctForChannel, applyReturnReserveCents } from "./returns.mjs";
import {
  evaluateMarketplaceEligibility,
  isOutboundAllowed,
  DEFAULT_CHANNEL_RULES,
} from "./marketplace-eligibility.mjs";
import { amazonNeverListReason, defaultCostCents } from "./amazon.mjs";

export const STORE_DEFAULT = "5487ca47-6147-4fe8-bc6d-46b6472726ba";

/** US TikTok Shop fee baseline for list-price bake-in (override with TIKTOK_SHOP_FEE_PCT). */
export const TIKTOK_DEFAULT_FEE_PCT = 0.08;

export const TIKTOK_OAUTH_REDIRECT =
  process.env.TIKTOK_SHOP_REDIRECT_URL ||
  "https://inventoryobi.netlify.app/.netlify/functions/tiktok-oauth-callback";

/** Scopes to request under Partner Center → Manage API (US seller). */
export const TIKTOK_API_SCOPES = [
  "seller.authorization.info",
  "seller.shop.info",
  "seller.product.read",
  "seller.product.write",
  "seller.order.info",
  "seller.order.refund",
  "seller.return_refund.basic",
  "seller.fulfillment.basic",
];

function apiBase() {
  return (process.env.TIKTOK_SHOP_API_BASE || "https://open-api.tiktokglobalshop.com").replace(/\/$/, "");
}

function authBase() {
  return (process.env.TIKTOK_SHOP_AUTH_BASE || "https://auth.tiktok-shops.com").replace(/\/$/, "");
}

export function tiktokAppCredsPresent() {
  return Boolean(
    (process.env.TIKTOK_SHOP_APP_KEY || "").trim() &&
      (process.env.TIKTOK_SHOP_APP_SECRET || "").trim(),
  );
}

export function tiktokListingEnabled() {
  return process.env.TIKTOK_SHOP_LISTING_ENABLED === "1";
}

export function tiktokFeePct() {
  const n = Number(process.env.TIKTOK_SHOP_FEE_PCT);
  if (Number.isFinite(n) && n > 0 && n < 1) return n;
  return TIKTOK_DEFAULT_FEE_PCT;
}

export function shopId() {
  return (process.env.TIKTOK_SHOP_SHOP_ID || "").trim();
}

export function serviceId() {
  return (process.env.TIKTOK_SHOP_SERVICE_ID || "").trim();
}

/** True when app creds + (encrypted tokens or env access token) + shop id are available. */
export function tiktokConfigured() {
  const hasTokenEnv = Boolean((process.env.TIKTOK_SHOP_ACCESS_TOKEN || "").trim());
  return tiktokAppCredsPresent() && Boolean(shopId()) && hasTokenEnv;
}

export function tiktokSetupChecklist() {
  return [
    "Create a TikTok Shop Partner account (partner.tiktokshop.com) and a US Custom app.",
    "Under Manage API, request seller order / product / return-refund scopes (see docs/TIKTOK_SHOP.md).",
    `Register redirect URL: ${TIKTOK_OAUTH_REDIRECT}`,
    "Set Netlify env: TIKTOK_SHOP_APP_KEY, TIKTOK_SHOP_APP_SECRET, TIKTOK_SHOP_SHOP_ID (optional TIKTOK_SHOP_SERVICE_ID).",
    "In Admin → Marketplaces → TikTok Shop, click Authorize TikTok Shop and complete seller consent.",
    "Optional: TIKTOK_SHOP_API_BASE (default https://open-api.tiktokglobalshop.com), TIKTOK_SHOP_LISTING_ENABLED=1.",
    "Smoke-test: POST /.netlify/functions/tiktok-returns-sync with {\"action\":\"status\"}.",
    "Confirm return_decision alerts hit FLOOR_OWNER_EMAIL within minutes of a test RMA (48h decision window).",
  ];
}

export function tiktokAuthorizeUrl(state) {
  if (!tiktokAppCredsPresent()) {
    throw new Error("tiktok_env_missing: set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET");
  }
  const svc = serviceId();
  if (svc) {
    return `https://services.tiktokshop.com/open/authorize?service_id=${encodeURIComponent(svc)}&state=${encodeURIComponent(state)}`;
  }
  const appKey = process.env.TIKTOK_SHOP_APP_KEY.trim();
  return `${authBase()}/oauth/authorize?app_key=${encodeURIComponent(appKey)}&state=${encodeURIComponent(state)}`;
}

/**
 * Sign a TikTok Shop Open API request (HMAC-SHA256).
 * Canonical: secret + path + sorted(key+value for query except sign/access_token) + body + secret
 */
export function signTikTokRequest({ path, params = {}, body = "" }) {
  const secret = (process.env.TIKTOK_SHOP_APP_SECRET || "").trim();
  if (!secret) throw new Error("tiktok_env_missing: TIKTOK_SHOP_APP_SECRET");
  const keys = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "access_token" && params[k] != null && params[k] !== "")
    .sort();
  let payload = secret + path;
  for (const k of keys) payload += k + String(params[k]);
  if (body) payload += typeof body === "string" ? body : JSON.stringify(body);
  payload += secret;
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function connectionRow(storeId) {
  const sb = serviceClient();
  const { data, error } = await sb
    .from("connections")
    .select("*")
    .eq("store_id", storeId)
    .eq("provider", "tiktok")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function persistTokens(storeId, tokens, { status = "connected", lastError = null, accountLabel = null } = {}) {
  const sb = serviceClient();
  const access = tokens.access_token || tokens.accessToken;
  const refresh = tokens.refresh_token || tokens.refreshToken;
  let expiresAt = null;
  const expRaw = tokens.access_token_expire_in ?? tokens.expires_in ?? tokens.expiresIn;
  if (expRaw != null) {
    const n = Number(expRaw);
    if (n > 1e12) expiresAt = new Date(n).toISOString();
    else if (n > 1e9) expiresAt = new Date(n * 1000).toISOString();
    else expiresAt = new Date(Date.now() + n * 1000).toISOString();
  }
  const row = await connectionRow(storeId).catch(() => null);
  const { error } = await sb.from("connections").upsert(
    {
      store_id: storeId,
      provider: "tiktok",
      status,
      account_label: accountLabel || shopId() || row?.account_label || null,
      token_ciphertext: access ? encryptSecret(access) : row?.token_ciphertext || null,
      refresh_ciphertext: refresh ? encryptSecret(refresh) : row?.refresh_ciphertext || null,
      scopes: Array.isArray(tokens.scope)
        ? tokens.scope
        : String(tokens.scope || "")
            .split(/[ ,]+/)
            .filter(Boolean),
      expires_at: expiresAt || row?.expires_at || null,
      last_error: lastError,
      connected_at: row?.connected_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id,provider" },
  );
  if (error) throw new Error(error.message);
}

async function alertTokenFailure(storeId, message) {
  const text = [
    "TikTok Shop token refresh failed.",
    `Store: ${storeId}`,
    `Error: ${message}`,
    "Re-authorize under Admin → Marketplaces → TikTok Shop.",
    `Redirect URL: ${TIKTOK_OAUTH_REDIRECT}`,
  ].join("\n");
  const to = (process.env.FLOOR_OWNER_EMAIL || process.env.GMAIL_SMTP_USER || "").split(",")[0]?.trim();
  if (gmailConfigured() && to) {
    await sendInternalAlert({ to, subject: "URGENT: TikTok Shop token refresh failed", text }).catch(() => undefined);
  }
}

/** Exchange authorization code for tokens (Partner auth.tiktok-shops.com). */
export async function exchangeTikTokCode(code) {
  if (!tiktokAppCredsPresent()) {
    throw new Error("tiktok_env_missing: set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET");
  }
  if (!code) throw new Error("tiktok_missing_auth_code");
  const appKey = process.env.TIKTOK_SHOP_APP_KEY.trim();
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET.trim();
  const url = new URL(`${authBase()}/api/v2/token/get`);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("app_secret", appSecret);
  url.searchParams.set("auth_code", code);
  url.searchParams.set("grant_type", "authorized_code");
  const res = await fetch(url.toString(), { method: "GET" });
  const json = await res.json().catch(() => ({}));
  const data = json.data || json;
  if (!res.ok || json.code > 0 || !data?.access_token) {
    const msg = json.message || json.msg || data?.message || `tiktok_token_exchange_failed HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function refreshAccessToken(storeId, row) {
  if (!tiktokAppCredsPresent()) {
    throw new Error("tiktok_env_missing: set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET");
  }
  const refreshToken = row?.refresh_ciphertext ? decryptSecret(row.refresh_ciphertext) : null;
  if (!refreshToken) {
    const err = new Error("tiktok_no_refresh_token — re-authorize TikTok Shop from Admin → Marketplaces");
    await alertTokenFailure(storeId, err.message);
    throw err;
  }
  const appKey = process.env.TIKTOK_SHOP_APP_KEY.trim();
  const appSecret = process.env.TIKTOK_SHOP_APP_SECRET.trim();
  const url = new URL(`${authBase()}/api/v2/token/refresh`);
  url.searchParams.set("app_key", appKey);
  url.searchParams.set("app_secret", appSecret);
  url.searchParams.set("refresh_token", refreshToken);
  url.searchParams.set("grant_type", "refresh_token");
  const res = await fetch(url.toString(), { method: "GET" });
  const json = await res.json().catch(() => ({}));
  const data = json.data || json;
  if (!res.ok || json.code > 0 || !data?.access_token) {
    const msg = json.message || json.msg || `tiktok_refresh_failed HTTP ${res.status}`;
    await persistTokens(storeId, {}, { status: "error", lastError: msg }).catch(() => undefined);
    await alertTokenFailure(storeId, msg);
    throw new Error(msg);
  }
  await persistTokens(storeId, data, { status: "connected", lastError: null });
  return data.access_token;
}

async function accessToken(storeId) {
  const row = await connectionRow(storeId).catch(() => null);
  const exp = row?.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (row?.token_ciphertext && exp > Date.now() + 5 * 60_000) {
    return decryptSecret(row.token_ciphertext);
  }
  if (row?.refresh_ciphertext) {
    return refreshAccessToken(storeId, row);
  }
  const envTok = (process.env.TIKTOK_SHOP_ACCESS_TOKEN || "").trim();
  if (envTok) return envTok;
  throw new Error("tiktok_not_connected — authorize from Admin → Marketplaces or set tokens");
}

/**
 * Signed Open API fetch. Returns parsed JSON; throws on transport/HTTP errors.
 * Does not invent success — callers must check TikTok `code` field.
 */
export async function tiktokApiFetch(storeId, method, path, bodyObj, extraParams = null) {
  if (!tiktokAppCredsPresent()) {
    throw new Error("tiktok_env_missing: set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET");
  }
  const token = await accessToken(storeId);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const params = {
    app_key: process.env.TIKTOK_SHOP_APP_KEY.trim(),
    timestamp,
  };
  if (extraParams && typeof extraParams === "object") {
    for (const [key, value] of Object.entries(extraParams)) {
      if (value != null && value !== "") params[key] = String(value);
    }
  }
  if (shopId()) params.shop_id = shopId();
  const body = bodyObj != null ? JSON.stringify(bodyObj) : "";
  params.sign = signTikTokRequest({ path, params, body });
  const qs = new URLSearchParams(params).toString();
  const url = `${apiBase()}${path}?${qs}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-tts-access-token": token,
    },
    body: body || undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`tiktok_api HTTP ${res.status}: ${String(text).slice(0, 300)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function saveTikTokOAuthTokens(storeId, tokenData) {
  await persistTokens(storeId, tokenData, {
    status: "connected",
    lastError: null,
    accountLabel: shopId() || tokenData.open_id || tokenData.seller_name || null,
  });
  const sb = serviceClient();
  await sb.from("channel_config").upsert(
    {
      store_id: storeId,
      channel: "tiktok",
      mode: "auto",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id,channel" },
  );
}

export async function tiktokConnectionStatus(storeId = STORE_DEFAULT) {
  const hasEnv = tiktokAppCredsPresent();
  const row = await connectionRow(storeId).catch(() => null);
  const connected = row?.status === "connected" && Boolean(row?.token_ciphertext || row?.refresh_ciphertext);
  let healthy = false;
  let lastError = row?.last_error || null;
  let shops = null;
  if (!hasEnv) {
    lastError = lastError || "tiktok_env_missing: TIKTOK_SHOP_APP_KEY / TIKTOK_SHOP_APP_SECRET";
  } else if (!connected && !(process.env.TIKTOK_SHOP_ACCESS_TOKEN || "").trim()) {
    lastError = lastError || "tiktok_not_connected";
  } else {
    try {
      const json = await tiktokApiFetch(storeId, "GET", "/authorization/202309/shops");
      if (json?.code === 0 || json?.data) {
        healthy = true;
        lastError = null;
        shops = json?.data?.shops || json?.data || json;
      } else {
        lastError = json?.message || json?.msg || `tiktok_api_code_${json?.code}`;
      }
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 300);
    }
  }
  return {
    connected: Boolean(connected || (process.env.TIKTOK_SHOP_ACCESS_TOKEN || "").trim()),
    healthy,
    shopId: shopId() || row?.account_label || null,
    serviceId: serviceId() || null,
    listingEnabled: tiktokListingEnabled(),
    hasEnvCreds: hasEnv,
    hasStoredTokens: Boolean(row?.token_ciphertext || row?.refresh_ciphertext),
    redirectUrl: TIKTOK_OAUTH_REDIRECT,
    scopes: TIKTOK_API_SCOPES,
    checklist: hasEnv && connected ? [] : tiktokSetupChecklist(),
    lastError,
    shops: Array.isArray(shops) ? shops.slice(0, 5) : shops,
    connectedAt: row?.connected_at || null,
    updatedAt: row?.updated_at || null,
    expiresAt: row?.expires_at || null,
  };
}

/**
 * Same online rule as Amazon (40% off retail / collectible ask, cover fees + $5 over cost)
 * plus TikTok fee pct + channel return reserve.
 */
export function suggestTikTokPriceCents(unit, feePct = TIKTOK_DEFAULT_FEE_PCT, returnReservePct = 0) {
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
  const fee = Number(feePct) || TIKTOK_DEFAULT_FEE_PCT;
  const minList = Math.ceil((cost + 500) / (1 - fee));
  let list = Math.max(target, minList);
  list = applyReturnReserveCents(list, returnReservePct);
  const feeCents = Math.round(list * fee);
  const profit = list - feeCents - cost;
  return {
    listCents: list,
    feeCents,
    costCents: cost,
    retailCents: Math.round(retail) || null,
    profitCents: profit,
    feePct: fee,
    returnReservePct: Number(returnReservePct) || 0,
    ok: profit >= 500 && list > 0,
  };
}

async function realPhotoPaths(storeId, sku) {
  const sb = serviceClient();
  const { data: unit } = await sb
    .from("units")
    .select("has_ai_images, has_stock_photos, has_manufacturer_photos")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .maybeSingle();
  if (unit?.has_ai_images === true || unit?.has_stock_photos === true || unit?.has_manufacturer_photos === true) {
    return { ok: false, reason: "needs_real_photos", paths: [] };
  }
  const { data: photos } = await sb
    .from("photos")
    .select("path, sort_order")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .order("sort_order", { ascending: true });
  const paths = (photos || []).map((p) => p.path).filter(Boolean);
  if (!paths.length) {
    const mainSku = await bundleMainSku(storeId, sku);
    if (mainSku) return realPhotoPaths(storeId, mainSku);
    return { ok: false, reason: "no_photos", paths: [] };
  }
  return { ok: true, paths, unitFlags: unit };
}

export async function prepareTikTokQueueItem(storeId, sku) {
  const sb = serviceClient();
  const { data: unit, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) throw new Error(error.message);
  if (!unit) return { ok: false, status: "error", last_error: "unknown_sku" };
  if (unit.state !== "available") return { ok: false, status: "error", last_error: `unit_state_${unit.state}` };

  const never = amazonNeverListReason(unit);
  if (never) return { ok: false, status: "error", last_error: never };

  const { count: ownPhotoCount } = await sb
    .from("photos")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId)
    .eq("sku", sku);
  const photoCount = ownPhotoCount || (await realPhotoPaths(storeId, sku)).paths.length;

  const gate = {
    block_conditions: ["fair", "defective", "for parts", "for_parts"],
    require_real_photos: true,
  };
  try {
    const { loadReturnSettings } = await import("./returns.mjs");
    const settings = await loadReturnSettings(storeId);
    Object.assign(gate, settings.gate_amazon_tiktok || {});
  } catch {
    /* defaults */
  }

  const elig = evaluateMarketplaceEligibility(unit, DEFAULT_CHANNEL_RULES.tiktok, {
    channel: "tiktok",
    photoCount: photoCount || 0,
    returnGate: gate,
  });
  if (!isOutboundAllowed(elig)) {
    return { ok: false, status: "error", last_error: elig.reason || "not_eligible" };
  }

  const photos = await realPhotoPaths(storeId, sku);
  if (!photos.ok) {
    return { ok: false, status: "error", last_error: photos.reason };
  }

  const returnReservePct = await reservePctForChannel(storeId, "tiktok").catch(() => 10);
  const price = suggestTikTokPriceCents(unit, tiktokFeePct(), returnReservePct);
  if (!price.ok) {
    return {
      ok: false,
      status: "error",
      last_error: `price_net_under_$5 (list=$${(price.listCents / 100).toFixed(2)})`,
      price,
    };
  }

  const patch = {
    status: "ready",
    tiktok_price_cents: price.listCents,
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  await sb.from("tiktok_list_items").upsert(
    { store_id: storeId, sku, ...patch },
    { onConflict: "store_id,sku" },
  );
  return { ok: true, status: "ready", price, photoCount: photos.paths.length };
}

/**
 * Push one product to TikTok Shop. Requires listing enabled + tokens.
 * Uses real photos only. Surfaces API errors; never fakes success.
 */
export async function listTikTokProduct(storeId, { unit, sku, priceCents } = {}) {
  if (!tiktokListingEnabled()) {
    return { ok: false, reason: "listing_disabled", message: "Set TIKTOK_SHOP_LISTING_ENABLED=1 to push products." };
  }
  if (!tiktokAppCredsPresent()) {
    return { ok: false, reason: "tiktok_env_missing", message: "TIKTOK_SHOP_APP_KEY / TIKTOK_SHOP_APP_SECRET required." };
  }
  let assignedCategory;
  try { assignedCategory = await assertBundlePush(storeId, sku || unit?.sku, 'tiktok'); }
  catch (error) { return { ok: false, reason: 'bundle_gate', message: error.message }; }
  const sb = serviceClient();
  const code = String(sku || unit?.sku || "").trim();
  let u = unit;
  if (!u) {
    const { data } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", code).maybeSingle();
    u = data;
  }
  if (!u) return { ok: false, reason: "unknown_sku" };

  const prep = await prepareTikTokQueueItem(storeId, code);
  if (!prep.ok) return { ok: false, reason: prep.last_error || prep.status, message: prep.last_error };

  const photos = await realPhotoPaths(storeId, code);
  if (!photos.ok) return { ok: false, reason: photos.reason, message: "Real unit photos required (no AI/stock)." };

  const returnReservePct = await reservePctForChannel(storeId, "tiktok").catch(() => 10);
  const price = suggestTikTokPriceCents(u, tiktokFeePct(), returnReservePct);
  const listCents = Number(priceCents) > 0 ? Math.round(Number(priceCents)) : price.listCents;

  const imageUris = [];
  for (const path of photos.paths.slice(0, 9)) {
    try {
      const { data: signed } = await sb.storage.from("unit-photos").createSignedUrl(path, 600);
      if (!signed?.signedUrl) continue;
      const imgRes = await tiktokApiFetch(storeId, "POST", "/product/202309/images/upload", {
        data: signed.signedUrl,
        use_case: "MAIN_IMAGE",
      });
      if (imgRes?.code !== 0) {
        return {
          ok: false,
          reason: "image_upload_failed",
          message: imgRes?.message || imgRes?.msg || JSON.stringify(imgRes).slice(0, 300),
          api: imgRes,
        };
      }
      const uri = imgRes?.data?.uri || imgRes?.data?.url || imgRes?.data?.img_id;
      if (uri) imageUris.push(uri);
    } catch (e) {
      return { ok: false, reason: "image_upload_failed", message: String(e?.message || e).slice(0, 300) };
    }
  }
  if (!imageUris.length) {
    return { ok: false, reason: "image_upload_failed", message: "No images accepted by TikTok API." };
  }

  const title = String(u.title || `SKU ${code}`).slice(0, 255);
  const description = String(u.listing_body || u.title || title).slice(0, 5000);
  const body = {
    category_id: assignedCategory.category_id,
    product_attributes: Object.entries(assignedCategory.attributes || {}).map(([id, value]) => ({ id,
      values: [/^\d+$/.test(String(value)) ? { id: String(value) } : { name: String(value) }] })),
    title,
    description,
    main_images: imageUris.map((uri) => ({ uri })),
    skus: [
      {
        seller_sku: code,
        price: { amount: (listCents / 100).toFixed(2), currency: "USD" },
        inventory: [{ warehouse_id: process.env.TIKTOK_SHOP_WAREHOUSE_ID || undefined, quantity: 1 }],
      },
    ],
    listing_platforms: ["TIKTOK_SHOP"],
    is_cod_open: false,
  };
  for (const s of body.skus) {
    s.inventory = s.inventory.map((inv) => {
      if (!inv.warehouse_id) {
        const { warehouse_id: _w, ...rest } = inv;
        return rest;
      }
      return inv;
    });
  }

  let api;
  try {
    api = await tiktokApiFetch(storeId, "POST", "/product/202309/products", body);
  } catch (e) {
    return { ok: false, reason: "product_create_failed", message: String(e?.message || e).slice(0, 300) };
  }
  if (api?.code !== 0) {
    return {
      ok: false,
      reason: "product_create_failed",
      message: api?.message || api?.msg || `tiktok_code_${api?.code}`,
      api,
    };
  }
  const productId = api?.data?.product_id || api?.data?.id || null;
  if (!productId) {
    return {
      ok: false,
      reason: "product_create_failed",
      message: "TikTok API returned success-shaped body without product_id",
      api,
    };
  }

  await sb.from("tiktok_list_items").upsert(
    {
      store_id: storeId,
      sku: code,
      status: "live",
      product_id: String(productId),
      tiktok_price_cents: listCents,
      listed_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "store_id,sku" },
  );
  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku: code,
      channel: "tiktok",
      status: "listed",
      listing_id: String(productId),
      listed_at: new Date().toISOString(),
      delisted_at: null,
    },
    { onConflict: "store_id,sku,channel" },
  );
  const listedOn = Array.isArray(u.listed_on) ? u.listed_on : [];
  if (!listedOn.includes("tiktok")) {
    await sb
      .from("units")
      .update({ listed_on: [...listedOn, "tiktok"], updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", code);
  }
  return { ok: true, sku: code, productId: String(productId), listCents, feeCents: price.feeCents };
}

function orderPaidCents(order) {
  const n =
    order?.payment?.total_amount ||
    order?.payment_info?.total_amount ||
    order?.order_amount ||
    order?.paid_amount ||
    0;
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  if (!Number.isInteger(num) || num < 1000) return Math.round(num * 100);
  return Math.round(num);
}

function orderSku(order) {
  const line = order?.line_items?.[0] || order?.item_list?.[0] || order?.order_line_list?.[0] || {};
  return String(line.seller_sku || line.sellerSku || line.sku || line.product_id || "").trim();
}

export async function ingestTikTokOrder(storeId, order) {
  const orderId = String(order?.order_id || order?.id || order?.orderId || "").trim();
  const sku = orderSku(order);
  if (!orderId || !sku) return { skipped: true, reason: "missing_order_or_sku" };

  const sb = serviceClient();
  const seen = await sb
    .from("channel_orders")
    .select("order_id")
    .eq("store_id", storeId)
    .eq("provider", "tiktok")
    .eq("order_id", orderId)
    .maybeSingle();
  if (seen.data) return { skipped: true, sku, orderId };

  const itemCents = orderPaidCents(order);
  const feeCents = Math.round(itemCents * tiktokFeePct());

  const { data: sale, error } = await sb.rpc("finalize_sale", {
    p_sku: String(sku),
    p_channel: "tiktok",
    p_price_cents: itemCents,
    p_payment_method: "tiktok",
    p_payment_id: `tiktok:${orderId}`,
    p_note: `TikTok Shop order (fee~$${(feeCents / 100).toFixed(2)})`,
    p_tax_cents: 0,
    p_approval_id: null,
  });
  if (error) {
    if (/unit_not_sellable|duplicate key|23505/i.test(error.message)) {
      await delistTikTokSku(storeId, sku).catch(() => undefined);
      const { withdrawSku } = await import("./ebay.mjs");
      await withdrawSku(storeId, sku).catch(() => undefined);
      const { zeroAmazonQuantityForSku } = await import("./amazon.mjs");
      await zeroAmazonQuantityForSku(storeId, sku).catch(() => undefined);
      return { ok: false, doubleSell: true, sku, orderId, error: error.message };
    }
    throw new Error(error.message);
  }

  await sb.from("channel_orders").insert({
    store_id: storeId,
    provider: "tiktok",
    order_id: orderId,
    sku: String(sku),
    sale_id: sale?.id ?? null,
    item_cents: itemCents,
  });

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
    shipping_cents: 0,
    tax_cents: 0,
    total_cents: itemCents,
    marketplace_fee_cents: feeCents,
    tax_remitted_by: "tiktok",
    payment_id: `tiktok:${orderId}`,
    order_no: orderId,
    paid_at: new Date().toISOString(),
    payment_env: "production",
    channel: "tiktok",
    match_status: "matched",
    marketplace_title: String(order?.line_items?.[0]?.product_name || order?.order_id || "").slice(0, 250) || null,
  });

  await delistTikTokSku(storeId, sku);
  const { withdrawSku } = await import("./ebay.mjs");
  await withdrawSku(storeId, String(sku)).catch(() => undefined);
  try {
    const { zeroAmazonQuantityForSku } = await import("./amazon.mjs");
    await zeroAmazonQuantityForSku(storeId, String(sku));
  } catch {
    /* optional */
  }

  return { sku, orderId, saleId: sale?.id, feeCents, itemCents };
}

export async function delistTikTokSku(storeId, sku) {
  const sb = serviceClient();
  await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku: String(sku),
      channel: "tiktok",
      status: "delisted",
      delisted_at: new Date().toISOString(),
    },
    { onConflict: "store_id,sku,channel" },
  );
  await sb
    .from("tiktok_list_items")
    .update({ status: "sold", updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", String(sku));
  const { data: unit } = await sb.from("units").select("listed_on").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (Array.isArray(unit?.listed_on) && unit.listed_on.includes("tiktok")) {
    await sb
      .from("units")
      .update({
        listed_on: unit.listed_on.filter((c) => c !== "tiktok"),
        updated_at: new Date().toISOString(),
      })
      .eq("store_id", storeId)
      .eq("sku", sku);
  }
  try {
    const { data: row } = await sb
      .from("tiktok_list_items")
      .select("product_id")
      .eq("store_id", storeId)
      .eq("sku", sku)
      .maybeSingle();
    if (row?.product_id && tiktokAppCredsPresent()) {
      await tiktokApiFetch(storeId, "POST", "/product/202309/products/deactivate", {
        product_ids: [row.product_id],
      });
    }
  } catch {
    /* Floor delist still applies */
  }
  return { ok: true, sku };
}

export async function pollTikTokOrders(storeId) {
  if (!tiktokAppCredsPresent()) {
    return { skipped: true, reason: "tiktok_env_missing", results: [] };
  }
  const row = await connectionRow(storeId).catch(() => null);
  if (!row?.token_ciphertext && !row?.refresh_ciphertext && !(process.env.TIKTOK_SHOP_ACCESS_TOKEN || "").trim()) {
    return { skipped: true, reason: "tiktok_not_connected", results: [] };
  }

  const days = Math.max(1, Number(process.env.TIKTOK_ORDERS_LOOKBACK_DAYS) || 14);
  const createTimeGe = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
  let api;
  try {
    api = await tiktokApiFetch(storeId, "POST", "/order/202309/orders/search", {
      page_size: 50,
      create_time_ge: createTimeGe,
      order_status: "AWAITING_SHIPMENT",
    });
  } catch (err) {
    return { error: String(err.message || err), results: [] };
  }
  if (api?.code != null && api.code !== 0) {
    return { error: api.message || api.msg || `tiktok_code_${api.code}`, results: [], api };
  }
  const orders = api?.data?.orders || api?.data?.order_list || [];
  const results = [];
  for (const order of orders) {
    try {
      results.push(await ingestTikTokOrder(storeId, order));
    } catch (err) {
      results.push({
        orderId: order?.order_id || order?.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { results, count: orders.length };
}

export async function runTikTokOrdersSyncJob(storeIdHint = STORE_DEFAULT) {
  const sb = serviceClient();
  const { data: rows } = await sb
    .from("connections")
    .select("store_id")
    .eq("provider", "tiktok")
    .eq("status", "connected");
  const storeIds = new Set((rows || []).map((r) => r.store_id));
  if (storeIds.size === 0 && (tiktokConfigured() || storeIdHint)) {
    storeIds.add(storeIdHint || STORE_DEFAULT);
  }
  const out = [];
  for (const storeId of storeIds) {
    const orders = await pollTikTokOrders(storeId).catch((e) => ({
      error: String(e.message || e),
      results: [],
    }));
    out.push({ storeId, orders });
  }
  return { ok: true, stores: out.length, results: out };
}

export function mapTikTokReturn(row = {}) {
  const id = String(row.return_id || row.returnId || row.id || "").trim();
  const orderId = String(row.order_id || row.orderId || row.order_sn || "").trim();
  const sku = String(
    row.seller_sku || row.sellerSku || row.sku || row.product_sku || "",
  ).trim();
  const statusRaw = String(row.return_status || row.status || "").toLowerCase();
  let status = "requested";
  if (/approved|agree/.test(statusRaw)) status = "approved";
  else if (/ship|transit/.test(statusRaw)) status = "in_transit";
  else if (/receiv|complete|success/.test(statusRaw)) status = "received";
  else if (/reject|deny|cancel/.test(statusRaw)) status = "denied";
  else if (/refund.?only|returnless/.test(statusRaw)) status = "refunded_no_return";

  const refund =
    Number(row.refund_amount?.amount || row.refund_amount || row.refundAmount || 0) || 0;
  const refundCents =
    refund > 0 && refund < 1000 && !Number.isInteger(refund)
      ? Math.round(refund * 100)
      : refund < 50 && Number.isInteger(refund)
        ? refund * 100
        : Math.round(refund);

  return {
    channel: "tiktok",
    external_return_id: id || (orderId ? `tiktok:${orderId}:${sku || "item"}` : null),
    external_order_id: orderId || null,
    sku: sku || null,
    reason: row.return_reason || row.reason || row.buyer_reason || "other",
    status,
    needs_decision: status === "requested",
    refund_cents: refundCents,
    return_label_cents: 0,
    label_paid_by: "unknown",
    raw: row,
  };
}

export async function syncTikTokReturns(storeId = STORE_DEFAULT) {
  if (!tiktokAppCredsPresent()) {
    return {
      ok: false,
      skipped: true,
      reason: "tiktok_not_configured",
      checklist: tiktokSetupChecklist(),
    };
  }

  const row = await connectionRow(storeId).catch(() => null);
  const hasTokens =
    Boolean(row?.token_ciphertext || row?.refresh_ciphertext) ||
    Boolean((process.env.TIKTOK_SHOP_ACCESS_TOKEN || "").trim());
  if (!hasTokens) {
    return {
      ok: false,
      skipped: true,
      reason: "tiktok_not_connected",
      checklist: tiktokSetupChecklist(),
    };
  }

  const days = Math.max(1, Number(process.env.TIKTOK_RETURNS_LOOKBACK_DAYS) || 14);
  const createTimeGe = Math.floor((Date.now() - days * 24 * 3600 * 1000) / 1000);
  let api;
  try {
    api = await tiktokApiFetch(storeId, "POST", "/return_refund/202309/returns/search", {
      page_size: 50,
      create_time_ge: createTimeGe,
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err), ingested: 0 };
  }
  if (api?.code != null && api.code !== 0) {
    return {
      ok: false,
      error: api.message || api.msg || `tiktok_code_${api.code}`,
      ingested: 0,
      api,
    };
  }

  const rows = api?.data?.return_orders || api?.data?.returns || api?.data?.return_list || [];
  let ingested = 0;
  const errors = [];
  for (const r of rows) {
    try {
      await ingestReturnRow(storeId, mapTikTokReturn(r));
      ingested += 1;
    } catch (e) {
      errors.push(String(e?.message || e).slice(0, 200));
    }
  }

  const sb = serviceClient();
  await sb.from("connections").upsert(
    {
      store_id: storeId,
      provider: "tiktok",
      status: "connected",
      account_label: shopId() || row?.account_label || null,
      updated_at: new Date().toISOString(),
      last_error: errors.length ? errors[0] : null,
    },
    { onConflict: "store_id,provider" },
  );

  return { ok: true, ingested, count: rows.length, errors: errors.slice(0, 5) };
}

export async function ingestTikTokFixture(storeId, fixture) {
  return ingestReturnRow(storeId, mapTikTokReturn(fixture));
}

/** Proactive refresh for scheduled jobs — alerts on failure. */
export async function ensureTikTokTokenFresh(storeId = STORE_DEFAULT) {
  const row = await connectionRow(storeId).catch(() => null);
  if (!row?.refresh_ciphertext) {
    return { ok: false, reason: "no_refresh_token" };
  }
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (exp > Date.now() + 30 * 60_000) {
    return { ok: true, refreshed: false };
  }
  try {
    await refreshAccessToken(storeId, row);
    return { ok: true, refreshed: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}
