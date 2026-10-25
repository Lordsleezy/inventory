/**
 * Admin listing manager: list / add / edit / end / migrate / bulk for Amazon / eBay / TikTok.
 * Enforced server-side via portalAdminFromEvent (clerks have no portal_admins row → 403).
 */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
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
import {
  endEverywhere,
  getBoardJobStatus,
  loadCatalog,
  loadQuarter,
  queueBoardJob,
  saveFloorListingFields,
} from "../lib/marketplace-board.mjs";
import { syncLiveChannels } from "../lib/channel-sync.mjs";

async function handleStaff(event) {
  const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  const action = String(body.action || "list").trim();
  const channel = String(body.channel || "").trim().toLowerCase();
  const { storeId, actor, userId } = await portalAdminFromEvent(event, body.store_id || STORE_DEFAULT);
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

  if (action === "depop_sale_units") {
    const q = query.trim().toLowerCase();
    const { data, error } = await serviceClient()
      .from("units")
      .select("sku, title, brand, ask_cents")
      .eq("store_id", storeId)
      .eq("state", "available")
      .order("sku", { ascending: false })
      .limit(5000);
    if (error) return json(400, { ok: false, error: error.message });
    const items = (data || [])
      .filter((u) => !q || `${u.sku} ${u.title || ""} ${u.brand || ""}`.toLowerCase().includes(q))
      .slice(0, 25);
    return json(200, { ok: true, items });
  }

  if (action === "record_depop_sale") {
    const sku = String(body.sku || "").trim();
    const orderNumber = String(body.order_number || "").trim();
    const cents = (v) => (v == null || v === "" ? 0 : Math.round(Number(v)));
    const price = Number(body.price_cents);
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    if (!orderNumber) return json(400, { ok: false, error: "depop_order_required" });
    if (!Number.isFinite(price) || price < 0) return json(400, { ok: false, error: "price_required" });
    const amounts = ["buyer_shipping_cents", "processing_fee_cents", "boosting_fee_cents", "label_cents"].map((k) => cents(body[k]));
    if (amounts.some((n) => !Number.isFinite(n) || n < 0)) return json(400, { ok: false, error: "invalid_amount" });
    const soldAt = body.sold_at ? new Date(`${String(body.sold_at).slice(0, 10)}T12:00:00`) : null;
    const { data, error } = await serviceClient().rpc("depop_record_manual_sale", {
      p_store: storeId,
      p_sku: sku,
      p_price_cents: Math.round(price),
      p_order_number: orderNumber,
      p_buyer_shipping_cents: amounts[0],
      p_processing_fee_cents: amounts[1],
      p_boosting_fee_cents: amounts[2],
      p_label_cents: amounts[3],
      p_sold_at: soldAt && !Number.isNaN(soldAt.getTime()) ? soldAt.toISOString() : null,
      p_actor: userId || null,
    });
    if (error) return json(400, { ok: false, error: error.message });
    if (data?.duplicate) return json(200, { ...data, pulled: [] });
    const pulled = await endEverywhere(storeId, sku, "depop", { sku });
    return json(200, { ...data, pulled });
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
    if (!["ebay", "amazon", "tiktok"].includes(channel)) return json(400, { ok: false, error: "channel_required" });
    const sku = String(body.sku || "").trim();
    if (!sku) return json(400, { ok: false, error: "sku_required" });
    const sb = serviceClient();
    const { data: before } = await sb
      .from("units")
      .select("ask_cents, title, listing_body, defect_notes")
      .eq("store_id", storeId)
      .eq("sku", sku)
      .maybeSingle();
    const nextAsk = body.price_cents != null && Number.isFinite(Number(body.price_cents)) ? Math.round(Number(body.price_cents)) : null;
    const sameText = (next, prev) => String(next ?? "").trim() === String(prev ?? "").trim();
    const nextTitle = body.title != null && String(body.title).trim() && !sameText(body.title, before?.title) ? String(body.title).trim() : null;
    const nextDescription = body.description != null && !sameText(body.description, before?.listing_body) ? String(body.description) : null;
    const nextNote = (body.condition_note ?? body.condition_description) != null
      && !sameText(body.condition_note ?? body.condition_description, before?.defect_notes)
      ? String(body.condition_note ?? body.condition_description)
      : null;
    const floor = await saveFloorListingFields(storeId, {
      sku,
      title: nextTitle,
      description: nextDescription,
      price_cents: nextAsk,
      condition: body.condition || null,
      condition_note: nextNote,
      shipping_mode: body.shipping_mode || null,
      channel,
    });
    if (!floor.ok) return json(400, floor);
    const synced = await syncLiveChannels(storeId, sku, {
      title: nextTitle,
      description: nextDescription,
      conditionNote: nextNote,
      imageUrls: body.image_urls || null,
      aspects: body.aspects || null,
      priceChanged: nextAsk != null && nextAsk !== before?.ask_cents,
      quantity: body.quantity != null && Number.isFinite(Number(body.quantity)) ? Math.round(Number(body.quantity)) : null,
      shippingMode: body.shipping_mode || null,
      originChannel: channel,
      offerId: body.offer_id || null,
      itemId: body.item_id || null,
      productId: body.product_id || null,
      accountId: body.account_id || null,
    });
    const ok = synced.ok !== false;
    return json(ok ? 200 : 400, {
      ok,
      sku,
      floor_ask_cents: nextAsk ?? before?.ask_cents ?? null,
      channels: synced.results || [],
      error: synced.error || null,
      shipping_warning: floor.shipping_warning || null,
    });
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

  if (action === "board_catalog") {
    return json(200, await loadCatalog(storeId, channel, { force: Boolean(body.force) }));
  }

  if (action === "board_quarter") {
    return json(200, await loadQuarter(storeId, channel, body.quarter || null));
  }

  if (action === "board_job") {
    const result = await queueBoardJob(storeId, {
      channel,
      kind: body.kind,
      items: body.items || [],
      requestedBy: actor || "portal",
    });
    return json(result.ok ? 200 : 400, result);
  }

  if (action === "board_job_status") {
    return json(200, { ok: true, job: await getBoardJobStatus(storeId) });
  }

  if (action === "board_floor_save") {
    const result = await saveFloorListingFields(storeId, { ...body, channel });
    return json(result.ok ? 200 : 400, result);
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
