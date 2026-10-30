/**
 * After a Floor edit, push title / photos / condition to every channel that SKU is live on,
 * and reprice each channel from the Floor ask. Depop has no listing API, so it is flagged.
 */
import { serviceClient } from "./server.mjs";
import { calcListPrice, estimateLabelCost } from "./marketplace-pricing.mjs";
import { reservePctForChannel } from "./returns.mjs";
import { applyEbayShippingMode } from "./ebay-shipping-edit.mjs";

async function markupCents(storeId, unit) {
  const own = unit?.listing_specs?.marketplace_packing_markup_cents;
  if (own != null && own !== "" && Number.isFinite(Number(own))) return Math.max(0, Math.round(Number(own)));
  const sb = serviceClient();
  const { data } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", "marketplace_packing_markup_cents")
    .maybeSingle();
  const raw = data?.value;
  const n = typeof raw === "number" ? raw : Number(typeof raw === "string" ? raw : raw ?? NaN);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 200;
}

export async function channelListCents(storeId, unit, channel, { shippingMode = null } = {}) {
  const ask = Number(unit?.ask_cents);
  if (!(ask > 0)) return null;
  const markup = await markupCents(storeId, unit);
  const reserve = await reservePctForChannel(storeId, channel).catch(() => 0);
  const sellerPaysLabel = channel === "ebay"
    ? shippingMode === "free"
    : channel === "amazon" || channel === "tiktok";
  const label = sellerPaysLabel ? estimateLabelCost(unit).labelCostCents : 0;
  return calcListPrice(ask, channel, label, markup, reserve);
}

async function flagDepop(storeId, sku, unit) {
  const specs = unit?.listing_specs && typeof unit.listing_specs === "object" ? { ...unit.listing_specs } : {};
  const manual = specs.manual_updates && typeof specs.manual_updates === "object" ? { ...specs.manual_updates } : {};
  manual.depop = {
    at: new Date().toISOString(),
    reason: "Listing changed in Floor. Update this Depop listing by hand — Depop has no listing API.",
  };
  specs.manual_updates = manual;
  const sb = serviceClient();
  await sb.from("units").update({ listing_specs: specs, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("sku", sku);
  return manual.depop.reason;
}

export async function syncLiveChannels(storeId, sku, change = {}) {
  const {
    patchEbayListing,
    patchAmazonListing,
    patchTikTokListing,
  } = await import("./listing-manager.mjs");
  const sb = serviceClient();
  const { data: unit, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!unit) return { ok: false, error: "unknown_sku" };
  const { data: found, error: listError } = await sb
    .from("listings")
    .select("channel, offer_id, listing_id, status, ebay_account_id")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("status", "listed");
  if (listError) return { ok: false, error: listError.message };
  const listings = [...(found || [])];
  if (change.originChannel && !listings.some((row) => row.channel === change.originChannel) && (change.offerId || change.itemId || change.productId)) {
    listings.push({
      channel: change.originChannel,
      offer_id: change.offerId || null,
      listing_id: change.itemId || change.productId || null,
      ebay_account_id: change.accountId || null,
      status: "listed",
    });
  }
  let ebayMode = change.shippingMode || null;
  if (change.priceChanged && !ebayMode && listings.some((row) => row.channel === "ebay")) {
    const { data: draft } = await sb
      .from("ebay_drafts")
      .select("shipping_mode")
      .eq("store_id", storeId)
      .eq("sku", sku)
      .maybeSingle();
    if (draft?.shipping_mode === "free" || draft?.shipping_mode === "calculated") ebayMode = draft.shipping_mode;
  }

  const results = [];
  const content = {
    title: change.title || null,
    description: change.description || null,
    conditionNote: change.conditionNote || null,
    imageUrls: change.imageUrls || null,
    aspects: change.aspects || null,
  };
  const touch = Boolean(content.title || content.description || content.conditionNote || content.imageUrls?.length || content.aspects || change.priceChanged);

  for (const row of listings || []) {
    const channel = row.channel;
    if (channel === "depop") {
      if (touch) {
        const reason = await flagDepop(storeId, sku, unit);
        results.push({ channel, ok: true, manual: true, message: reason });
      }
      continue;
    }
    let priceCents = null;
    if (change.priceChanged) {
      priceCents = await channelListCents(storeId, unit, channel, {
        shippingMode: channel === "ebay" ? ebayMode : null,
      });
    }
    try {
      let result = { ok: true };
      const quantity = channel === change.originChannel && change.quantity != null ? change.quantity : null;
      if (channel === "ebay" && (touch || priceCents != null || quantity != null)) {
        result = await patchEbayListing(storeId, {
          sku,
          accountId: row.ebay_account_id || change.accountId || null,
          offerId: row.offer_id,
          itemId: row.listing_id || change.itemId || null,
          priceCents,
          quantity,
          title: content.title,
          description: content.description,
          conditionDescription: content.conditionNote,
          imageUrls: content.imageUrls,
          aspects: content.aspects,
          syncFloorAsk: false,
        });
      } else if (channel === "amazon" && (touch || priceCents != null || quantity != null)) {
        result = await patchAmazonListing(storeId, {
          sku,
          offerSku: sku,
          priceCents,
          quantity,
          title: content.title,
          description: content.description,
          conditionNote: content.conditionNote,
          imageUrls: content.imageUrls,
          syncFloorAsk: false,
        });
      } else if (channel === "tiktok" && (touch || priceCents != null)) {
        result = await patchTikTokListing(storeId, {
          sku,
          productId: row.listing_id,
          priceCents,
          title: content.title,
          description: content.description,
          imageUrls: content.imageUrls,
          syncFloorAsk: false,
        });
      }
      results.push({ channel, ok: result?.ok !== false, error: result?.error || null, price_cents: priceCents });
    } catch (err) {
      results.push({ channel, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (change.shippingMode) {
    const ebay = listings.find((row) => row.channel === "ebay");
    if (ebay) {
      try {
        const shipped = await applyEbayShippingMode(storeId, {
          sku,
          accountId: ebay.ebay_account_id || change.accountId || null,
          itemId: change.itemId || ebay.listing_id,
          offerId: change.offerId || ebay.offer_id,
          mode: change.shippingMode,
        });
        results.push({ channel: "ebay", ok: shipped.ok !== false, shipping: shipped.mode || change.shippingMode, via: shipped.via, error: shipped.error || null });
      } catch (err) {
        results.push({ channel: "ebay", ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const failed = results.filter((row) => row.ok === false);
  return {
    ok: failed.length === 0,
    results,
    error: failed.map((row) => `${row.channel}: ${row.error}`).join(" · ") || null,
  };
}
