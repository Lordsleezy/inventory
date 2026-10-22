/**
 * Admin listing manager: list / add / edit / end / migrate / bulk for Amazon / eBay / TikTok.
 * Enforced server-side via portalAdminFromEvent (clerks have no portal_admins row → 403).
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
  relistEbayListing,
  listTikTokListings,
  patchTikTokListing,
  endTikTokListing,
  listDepopListings,
  buildDepopPack,
  confirmDepopListed,
  endDepopListing,
  listEligibleUnits,
  prefillCreate,
  publishCreate,
  getListingDetail,
  queueBulkPublish,
  getBulkPublishStatus,
  listLegacyEbayCandidates,
  migrateEbayListingsToInventory,
  readSync,
} from "../lib/listing-manager.mjs";

async function handleStaff(event) {
  const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  const action = String(body.action || "list").trim();
  const channel = String(body.channel || "").trim().toLowerCase();
  const { storeId, actor } = await portalAdminFromEvent(event, body.store_id || STORE_DEFAULT);
  const query = body.query || "";
  const limit = Math.min(2000, Math.max(1, Number(body.limit) || (action === "list" ? 2000 : 50)));

  if (action === "list") {
    if (channel === "amazon") return json(200, await listAmazonListings(storeId, { query, limit }));
    if (channel === "ebay") return json(200, await listEbayListings(storeId, { query, limit }));
    if (channel === "tiktok") return json(200, await listTikTokListings(storeId, { query, limit }));
    if (channel === "depop") return json(200, await listDepopListings(storeId, { query, limit }));
    return json(400, { ok: false, error: "channel_required", channels: ["amazon", "ebay", "tiktok", "depop"] });
  }

  if (action === "sync_meta") {
    return json(200, {
      ok: true,
      last_synced: {
        amazon: await readSync(storeId, "amazon"),
        ebay: await readSync(storeId, "ebay"),
        tiktok: await readSync(storeId, "tiktok"),
        depop: await readSync(storeId, "depop"),
      },
      bulk: await getBulkPublishStatus(storeId),
    });
  }

  if (action === "eligible") {
    return json(200, await listEligibleUnits(storeId, { channel, query, limit }));
  }

  if (action === "prefill") {
    if (!body.sku) return json(400, { ok: false, error: "sku_required" });
    return json(200, await prefillCreate(storeId, { channel, sku: String(body.sku).trim() }));
  }

  if (action === "depop_pack") {
    if (!body.sku) return json(400, { ok: false, error: "sku_required" });
    return json(200, await buildDepopPack(storeId, { sku: String(body.sku).trim() }));
  }

  if (action === "depop_confirm") {
    if (!body.sku) return json(400, { ok: false, error: "sku_required" });
    const result = await confirmDepopListed(storeId, {
      sku: String(body.sku).trim(),
      depopUrl: body.depop_url || body.url || null,
      markOnly: Boolean(body.mark_only),
    });
    return json(result.ok ? 200 : 400, result);
  }

  if (action === "detail") {
    return json(
      200,
      await getListingDetail(storeId, {
        channel,
        sku: body.sku,
        offerId: body.offer_id,
        accountId: body.account_id,
        productId: body.product_id,
      }),
    );
  }

  if (action === "publish" || action === "create") {
    const result = await publishCreate(storeId, {
      channel,
      sku: String(body.sku || "").trim(),
      title: body.title || null,
      description: body.description || null,
      priceCents: body.price_cents != null ? Math.round(Number(body.price_cents)) : null,
      imageUrls: body.image_urls || null,
      aspects: body.aspects || null,
      confirmCreate: Boolean(body.confirm_create),
    });
    return json(result.ok || result.needs_confirm ? 200 : 400, result);
  }

  if (action === "bulk_publish") {
    const result = await queueBulkPublish(storeId, {
      channel,
      skus: body.skus || [],
      requestedBy: actor || "portal",
    });
    return json(result.ok ? 200 : 400, result);
  }

  if (action === "bulk_status") {
    return json(200, { ok: true, bulk: await getBulkPublishStatus(storeId) });
  }

  if (action === "patch") {
    if (channel === "amazon") {
      const result = await patchAmazonListing(storeId, {
        sku: body.sku,
        offerSku: body.offer_sku,
        priceCents: body.price_cents != null ? Math.round(Number(body.price_cents)) : null,
        quantity: body.quantity != null ? Math.round(Number(body.quantity)) : null,
        title: body.title || null,
        bullets: body.bullets || null,
        description: body.description || null,
        conditionNote: body.condition_note || null,
        productType: body.product_type || null,
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
        title: body.title || null,
        description: body.description || null,
        conditionDescription: body.condition_note || body.condition_description || null,
        imageUrls: body.image_urls || null,
        aspects: body.aspects || null,
        syncFloorAsk: body.sync_floor_ask !== false,
      });
      return json(result.ok ? 200 : 400, result);
    }
    if (channel === "tiktok") {
      const result = await patchTikTokListing(storeId, {
        productId: body.product_id,
        sku: body.sku,
        priceCents: body.price_cents != null ? Math.round(Number(body.price_cents)) : null,
        title: body.title || null,
        description: body.description || null,
        syncFloorAsk: body.sync_floor_ask !== false,
      });
      return json(result.ok ? 200 : 400, result);
    }
    return json(400, { ok: false, error: "channel_required" });
  }

  if (action === "end") {
    if (channel === "amazon") {
      const result = await endAmazonListing(storeId, { sku: body.sku, offerSku: body.offer_sku });
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
    if (channel === "tiktok") {
      const result = await endTikTokListing(storeId, { productId: body.product_id, sku: body.sku });
      return json(result.ok ? 200 : 400, result);
    }
    if (channel === "depop") {
      const result = await endDepopListing(storeId, { sku: body.sku });
      return json(result.ok ? 200 : 400, result);
    }
    return json(400, { ok: false, error: "end_not_supported", channel });
  }

  if (action === "relist") {
    if (channel !== "ebay") return json(400, { ok: false, error: "relist_ebay_only" });
    const result = await relistEbayListing(storeId, {
      sku: body.sku,
      offerId: body.offer_id || null,
      accountId: body.account_id || null,
    });
    return json(result.ok ? 200 : 400, result);
  }

  if (action === "migrate_candidates") {
    return json(200, await listLegacyEbayCandidates(storeId, { limit: Math.min(100, limit) }));
  }

  if (action === "migrate_one" || action === "migrate_batch") {
    const listingIds = body.listing_ids || (body.listing_id ? [body.listing_id] : []);
    const result = await migrateEbayListingsToInventory(storeId, {
      listingIds,
      dryRun: Boolean(body.dry_run),
    });
    return json(result.ok || result.dryRun ? 200 : 400, result);
  }

  if (action === "capabilities") {
    return json(200, {
      ok: true,
      admin_only: true,
      channels: {
        amazon: {
          list: true,
          add: "UPC match → offer; else create VALIDATION_PREVIEW / live",
          edit: "title, bullets, description, price, qty, condition note (images need Amazon-hosted locator)",
          end: "qty 0",
          bulk: true,
          relist: false,
        },
        ebay: {
          list: true,
          add: "Inventory API on ikonikdeals2026 + business policies",
          edit: "title, description, photos, aspects, price, qty (Inventory API only)",
          end: "offer withdraw / Trading EndItem — does not mark unit sold",
          relist: true,
          migrate: "bulk_migrate_listing for Trading/Vendoo → Inventory",
          bulk: true,
        },
        tiktok: {
          list: true,
          add: true,
          edit: "title, description, price (Partner API)",
          end: "deactivate",
          bulk: true,
          requires: "Partner app keys + OAuth",
        },
        depop: {
          list: true,
          add: "Push pack (copy/paste) → paste Depop URL or Listed on Depop",
          edit: false,
          end: "Clears Floor listing row + listed_on — does not mark sold; end on Depop yourself",
          bulk: false,
          note: "No public Depop listing API. Sales still ingest via Depop email poll.",
        },
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
