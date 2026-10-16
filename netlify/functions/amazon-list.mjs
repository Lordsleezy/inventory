/**
 * Admin Amazon queue actions (prepare / ASIN / price / list one).
 * Kept separate from amazon-sync so the scheduled sync bundle stays small.
 */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import {
  amazonConnectionStatus,
  amazonListingEnabled,
  prepareAmazonQueueItem,
  listAmazonOffer,
  syncAmazonOfferQuantity,
  syncAmazonOfferForFloorSku,
  STORE_DEFAULT,
} from "../lib/amazon.mjs";

const STORE = STORE_DEFAULT;

async function handleStaff(event) {
  const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  const action = String(body.action || "").trim();
  const { storeId } = await portalAdminFromEvent(event, body.store_id || STORE);
  const sb = serviceClient();
  const sku = body.sku != null ? String(body.sku).trim() : "";

  if (action === "status" || !action) {
    const status = await amazonConnectionStatus(storeId);
    return json(200, { ok: true, ...status, listingEnabled: amazonListingEnabled() });
  }

  if (action === "prepare" || action === "retry") {
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    const result = await prepareAmazonQueueItem(storeId, sku);
    return json(200, { ok: true, ...result });
  }

  if (action === "set_asin") {
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    const asin = String(body.asin || "").trim().toUpperCase();
    if (!/^B0[A-Z0-9]{8}$/i.test(asin)) return json(400, { ok: false, error: "invalid_asin" });
    await sb
      .from("amazon_list_items")
      .update({ asin, updated_at: new Date().toISOString(), last_error: null })
      .eq("store_id", storeId)
      .eq("sku", sku);
    const { data: unit } = await sb.from("units").select("listing_specs").eq("store_id", storeId).eq("sku", sku).maybeSingle();
    const specs = { ...(unit?.listing_specs || {}), asin };
    await sb.from("units").update({ listing_specs: specs }).eq("store_id", storeId).eq("sku", sku);
    return json(200, { ok: true, sku, asin });
  }

  if (action === "set_price") {
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    const cents = Math.round(Number(body.price_cents));
    if (!Number.isFinite(cents) || cents < 500) return json(400, { ok: false, error: "price_too_low" });
    await sb
      .from("amazon_list_items")
      .update({ amazon_price_cents: cents, updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", sku);
    return json(200, { ok: true, sku, amazon_price_cents: cents });
  }

  if (action === "list_one") {
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    const { data: row } = await sb.from("amazon_list_items").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
    const { data: unit } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
    if (!unit) return json(404, { ok: false, error: "unknown_sku" });
    await sb
      .from("amazon_list_items")
      .update({ status: "listing", updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", sku);
    const qtyCap = body.quantity != null ? Math.max(0, Math.round(Number(body.quantity))) : row?.qty_cap ?? null;
    const result = await listAmazonOffer(storeId, {
      unit,
      sku,
      asin: row?.asin || unit.listing_specs?.asin || body.asin || null,
      priceCents: row?.amazon_price_cents || body.price_cents || null,
      quantity: qtyCap,
      qtyCap,
      conditionOverride: body.condition_override || null,
      productType: body.product_type || null,
    });
    if (result.ok) {
      await sb
        .from("amazon_list_items")
        .update({
          status: "live",
          asin: result.asin,
          listing_sku: result.offerSku || result.sku,
          offer_sku: result.offerSku || result.sku,
          pool_upc: result.poolUpc || null,
          qty_cap: result.qtyCap ?? qtyCap,
          qty_listed: result.quantity ?? null,
          listed_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("store_id", storeId)
        .eq("sku", sku);
    } else {
      await sb
        .from("amazon_list_items")
        .update({
          status: result.reason === "needs_asin" ? "needs_review" : "error",
          last_error: result.message || result.reason || "list_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("store_id", storeId)
        .eq("sku", sku);
    }
    return json(result.ok ? 200 : 400, result);
  }

  if (action === "sync_qty") {
    const offerSku = String(body.offer_sku || body.sku || "").trim();
    if (!offerSku) return json(400, { ok: false, error: "offer_sku_required" });
    const result = await syncAmazonOfferQuantity(storeId, offerSku);
    return json(200, { ok: true, ...result });
  }

  if (action === "sync_floor_sku") {
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    const result = await syncAmazonOfferForFloorSku(storeId, sku);
    return json(200, { ok: true, ...result });
  }

  return json(400, { ok: false, error: "unknown_action", action });
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod && event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }
  try {
    return await handleStaff(event);
  } catch (err) {
    const status = err?.status || 500;
    const message = err instanceof Error ? err.message : String(err);
    return json(status, { ok: false, error: message });
  }
}

export const invoke = wrapHandler("amazon-list", handle);
export default asNetlifyFunction(invoke);
