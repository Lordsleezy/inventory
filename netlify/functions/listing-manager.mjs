/**
 * Admin listing manager: list + patch Amazon / eBay / TikTok live listings.
 */
import { json, corsHeaders } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import {
  STORE_DEFAULT,
  listAmazonListings,
  patchAmazonListing,
  endAmazonListing,
  listEbayListings,
  patchEbayListing,
  endEbayListing,
  listTikTokListings,
  patchTikTokListing,
} from "../lib/listing-manager.mjs";

async function handleStaff(event) {
  const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  const action = String(body.action || "list").trim();
  const channel = String(body.channel || "").trim().toLowerCase();
  const { storeId } = await portalAdminFromEvent(event, body.store_id || STORE_DEFAULT);
  const query = body.query || "";
  const limit = Math.min(100, Math.max(1, Number(body.limit) || 50));

  if (action === "list") {
    if (channel === "amazon") return json(200, await listAmazonListings(storeId, { query, limit }));
    if (channel === "ebay") return json(200, await listEbayListings(storeId, { query, limit }));
    if (channel === "tiktok") return json(200, await listTikTokListings(storeId, { query, limit }));
    return json(400, { ok: false, error: "channel_required", channels: ["amazon", "ebay", "tiktok"] });
  }

  if (action === "patch") {
    if (channel === "amazon") {
      const result = await patchAmazonListing(storeId, {
        sku: body.sku,
        offerSku: body.offer_sku,
        priceCents: body.price_cents != null ? Math.round(Number(body.price_cents)) : null,
        quantity: body.quantity != null ? Math.round(Number(body.quantity)) : null,
        syncFloorAsk: body.sync_floor_ask !== false,
      });
      return json(result.ok ? 200 : 400, result);
    }
    if (channel === "ebay") {
      const result = await patchEbayListing(storeId, {
        accountId: body.account_id,
        offerId: body.offer_id,
        sku: body.sku,
        priceCents: body.price_cents != null ? Math.round(Number(body.price_cents)) : null,
        quantity: body.quantity != null ? Math.round(Number(body.quantity)) : null,
        syncFloorAsk: body.sync_floor_ask !== false,
      });
      return json(result.ok ? 200 : 400, result);
    }
    if (channel === "tiktok") {
      const result = await patchTikTokListing(storeId, {
        productId: body.product_id,
        sku: body.sku,
        priceCents: body.price_cents != null ? Math.round(Number(body.price_cents)) : null,
        syncFloorAsk: body.sync_floor_ask !== false,
      });
      return json(result.ok ? 200 : 400, result);
    }
    return json(400, { ok: false, error: "channel_required" });
  }

  if (action === "end") {
    if (channel === "amazon") {
      const result = await endAmazonListing(storeId, {
        sku: body.sku,
        offerSku: body.offer_sku,
      });
      return json(result.ok ? 200 : 400, result);
    }
    if (channel === "ebay") {
      const result = await endEbayListing(storeId, {
        accountId: body.account_id,
        offerId: body.offer_id,
        sku: body.sku,
      });
      return json(result.ok ? 200 : 400, result);
    }
    return json(400, { ok: false, error: "end_not_supported", channel });
  }

  if (action === "capabilities") {
    return json(200, {
      ok: true,
      channels: {
        amazon: { list: true, edit_price: true, edit_qty: true, end: "qty 0 via Listings Items PATCH" },
        ebay: {
          list: true,
          edit_price: "Inventory API offers only",
          edit_qty: "Inventory API offers only",
          end: "offer withdraw (Inventory API)",
          legacy_vendoo: "Floor-only rows — edit in Seller Hub",
        },
        tiktok: { list: true, edit_price: true, requires: "Partner app keys + OAuth", end: "not wired yet" },
        depop: { list: false, note: "No public listing management API — browser automation only, skip" },
      },
    });
  }

  return json(400, { ok: false, error: "unknown_action" });
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod && event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  try {
    return await handleStaff(event);
  } catch (err) {
    const status = err?.status || 500;
    return json(status, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export const invoke = wrapHandler("listing-manager", handle);
export default asNetlifyFunction(invoke);
