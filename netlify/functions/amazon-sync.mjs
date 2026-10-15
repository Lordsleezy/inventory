/**
 * Amazon order sync (scheduled) + Admin Amazon queue actions.
 *
 * Schedule body `{ next_run }` → poll orders / finances / multi-unit qty reconcile.
 * Staff Bearer → status | prepare | set_asin | set_price | retry | list_one | sync_qty.
 */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import {
  amazonConnectionStatus,
  amazonListingEnabled,
  prepareAmazonQueueItem,
  listAmazonOffer,
  createAmazonChristmasLightsListing,
  christmasLightsListingCopy,
  runAmazonSyncJob,
  syncAmazonOfferQuantity,
  syncAmazonOfferForFloorSku,
  catalogItemByUpc,
  competitivePriceByAsin,
  suggestAmazonPriceCents,
  getFeesEstimate,
  defaultCostCents,
  STORE_DEFAULT,
} from "../lib/amazon.mjs";

const STORE = STORE_DEFAULT;

/** One-shot Christmas-lights NEW catalog list when AMAZON_BOOTSTRAP_TEST_LIST=1 (allowlisted UPC only). */
async function maybeBootstrapTestList(storeId) {
  if (process.env.AMAZON_BOOTSTRAP_TEST_LIST !== "1") return null;
  if (!amazonListingEnabled()) return { skipped: true, reason: "listing_disabled" };
  const upc = (process.env.AMAZON_LISTING_ALLOWLIST || "").split(",")[0]?.replace(/\D/g, "");
  if (!upc) return { skipped: true, reason: "no_allowlist_upc" };
  const lightsUpc = christmasLightsListingCopy().upc;
  // Preferred path: create NEW Amazon product for Holiday Living lights (not ASIN-join offer-only).
  if (upc.replace(/\D/g, "").padStart(12, "0").slice(-12) === lightsUpc) {
    const sb = serviceClient();
    const offerSku = `AMZ-${lightsUpc}`;
    const { data: existing } = await sb
      .from("listings")
      .select("sku, status")
      .eq("store_id", storeId)
      .eq("channel", "amazon")
      .eq("sku", offerSku)
      .maybeSingle();
    if (existing?.status === "listed") return { skipped: true, reason: "already_listed", offerSku, mode: "new_catalog" };
    const created = await createAmazonChristmasLightsListing(storeId);
    return { mode: "new_catalog", ...created };
  }

  const sb = serviceClient();
  const offerSku = `AMZ-${upc.padStart(12, "0").slice(-12)}`;
  const { data: existing } = await sb
    .from("listings")
    .select("sku, status")
    .eq("store_id", storeId)
    .eq("channel", "amazon")
    .eq("sku", offerSku)
    .maybeSingle();
  if (existing?.status === "listed") return { skipped: true, reason: "already_listed", offerSku };

  const { data: unit } = await sb
    .from("units")
    .select("*")
    .eq("store_id", storeId)
    .eq("upc", upc.padStart(12, "0").slice(-12))
    .eq("state", "available")
    .order("received_at", { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!unit) return { skipped: true, reason: "no_available_unit", upc };

  let catalog = await catalogItemByUpc(storeId, upc);
  let asin = catalog.item?.asin;
  let matchSource = "upc";
  if (!asin) return { ok: false, reason: "no_asin_use_new_catalog_path", upc, matchSource, catalog };

  const amazonPrice = await competitivePriceByAsin(storeId, asin);
  unit.listing_specs = {
    ...(unit.listing_specs || {}),
    upc,
    asin,
    retail_cents: amazonPrice.price_cents || Math.round(Number(unit.listing_specs?.median_retail_usd || 19.99) * 100),
  };
  const price = suggestAmazonPriceCents(unit);
  const fees = await getFeesEstimate(storeId, { asin, priceCents: price.listCents });
  const feePct = fees.feeCents / Math.max(price.listCents, 1);
  let listCents = suggestAmazonPriceCents(unit, feePct).listCents;
  if (amazonPrice.price_cents > 0) listCents = Math.min(listCents, amazonPrice.price_cents - 1);
  const ship = Math.max(0, Number(unit.shipping_cents) || 0); // buyer-pays FBM → 0 baked
  const cost = defaultCostCents(unit);
  const minList = Math.ceil((cost + 500 + ship) / Math.max(1 - feePct, 0.01));
  if (listCents < minList) listCents = minList;

  const result = await listAmazonOffer(storeId, {
    unit,
    asin,
    priceCents: listCents,
    quantity: 5,
    qtyCap: 5,
    productType: catalog.item?.productType || "PRODUCT",
    conditionOverride: {
      amazon: "new_new",
      note: "Brand new, sealed in original packaging. We ship ourselves (FBM).",
      confident: true,
    },
  });

  if (result.ok) {
    await sb.from("amazon_list_items").upsert(
      {
        store_id: storeId,
        sku: unit.sku,
        status: "live",
        asin: result.asin,
        matched_title: catalog.item?.title || null,
        amazon_price_cents: listCents,
        fee_estimate_cents: Math.round(listCents * feePct),
        condition_code: "new_new",
        condition_note: "Brand new, sealed in original packaging.",
        listing_sku: result.offerSku,
        offer_sku: result.offerSku,
        pool_upc: upc.padStart(12, "0").slice(-12),
        qty_cap: 5,
        qty_listed: result.quantity,
        listed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        note: "Bootstrap test: Christmas lights multi-unit",
        cost_cents: cost,
        retail_cents: unit.listing_specs.retail_cents,
      },
      { onConflict: "store_id,sku" },
    );
  }

  return {
    bootstrap: true,
    catalog: {
      asin,
      title: catalog.item?.title,
      image: catalog.item?.images?.[0] || null,
      brand: catalog.item?.brand,
    },
    amazonPrice,
    listCents,
    cost,
    feePct,
    result,
  };
}

async function handleStaff(event) {
  const body = JSON.parse(event.body || "{}");
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
    const asin = String(body.asin || "")
      .trim()
      .toUpperCase();
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

  if (action === "poll") {
    const result = await runAmazonSyncJob(storeId);
    return json(200, result);
  }

  return json(400, { ok: false, error: "unknown_action", action });
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };

  // Scheduled cron (or empty/poll without auth when next_run present)
  if (isNetlifyScheduleEvent(event) || event.httpMethod === "GET") {
    const sb = serviceClient();
    const result = await withLock(
      "amazon-sync",
      240,
      async () => {
        const sync = await runAmazonSyncJob(STORE);
        const bootstrap = await maybeBootstrapTestList(STORE).catch((e) => ({
          ok: false,
          error: String(e.message || e),
        }));
        return { ...sync, bootstrap };
      },
      sb,
    );
    return json(200, result);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    body = {};
  }

  // Scheduled-shaped body without X-Nf-Event (Netlify sometimes omits the header)
  if (body.next_run && !body.action) {
    const sb = serviceClient();
    const result = await withLock(
      "amazon-sync",
      240,
      async () => {
        const sync = await runAmazonSyncJob(STORE);
        const bootstrap = await maybeBootstrapTestList(STORE).catch((e) => ({
          ok: false,
          error: String(e.message || e),
        }));
        return { ...sync, bootstrap };
      },
      sb,
    );
    return json(200, result);
  }

  try {
    return await handleStaff(event);
  } catch (err) {
    const status = err?.status || 500;
    return json(status, { ok: false, error: err?.message || String(err) });
  }
}

export const handler = wrapHandler("amazon-sync", handle);
