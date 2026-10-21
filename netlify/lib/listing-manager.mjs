/**
 * Cross-channel live listing manager (Amazon / eBay / TikTok).
 * Floor remains source of truth for SKU/cost/sold; price edits sync to units.ask_cents when requested.
 */
import { serviceClient } from "./server.mjs";
import { STORE_DEFAULT, spapiFetch, marketplaceId, suggestAmazonPriceCents } from "./amazon.mjs";
import { ebayFetch, listEbayAccounts } from "./ebay.mjs";
import { tiktokApiFetch, tiktokConnectionStatus, ensureTikTokTokenFresh } from "./tiktok-shop.mjs";

function sellerId() {
  return (process.env.AMAZON_SELLER_ID || "").trim();
}

function underFloorWarn(unit, listCents) {
  if (!unit || listCents == null) return null;
  const price = suggestAmazonPriceCents(unit, 0.15, 0.1);
  const net = listCents - (price.listCents - price.netCents || 0);
  // Rough: warn if below Floor ask or below $5 over cost
  const cost = Number(unit.acquisition_cost_cents || unit.floor_cents || price.costCents || 0);
  const profit = listCents - cost - Math.round(listCents * 0.15);
  if (profit < 500) {
    return `Price $${(listCents / 100).toFixed(2)} may net under $5 after ~15% fees/cost (profit≈$${(profit / 100).toFixed(2)}).`;
  }
  if (unit.ask_cents && listCents < unit.ask_cents) {
    return `Below Floor ask $${(unit.ask_cents / 100).toFixed(2)}.`;
  }
  return null;
}

export async function listAmazonListings(storeId = STORE_DEFAULT, { query = "", limit = 50 } = {}) {
  const sid = sellerId();
  if (!sid) return { ok: false, error: "AMAZON_SELLER_ID missing", items: [] };
  const sb = serviceClient();
  // Floor listings table + live queue
  const { data: floorRows } = await sb
    .from("listings")
    .select("sku, status, listing_id, offer_id, listed_at, updated_at")
    .eq("store_id", storeId)
    .eq("channel", "amazon")
    .neq("status", "ended")
    .limit(200);
  const { data: queue } = await sb
    .from("amazon_list_items")
    .select("sku, asin, status, amazon_price_cents, listing_sku, offer_sku, qty_listed, needs_review_reason")
    .eq("store_id", storeId)
    .neq("status", "removed")
    .limit(200);
  const skus = [...new Set([...(floorRows || []).map((r) => r.sku), ...(queue || []).map((r) => r.sku)])];
  const { data: units } = skus.length
    ? await sb.from("units").select("sku, title, ask_cents, state, brand").eq("store_id", storeId).in("sku", skus)
    : { data: [] };
  const unitMap = Object.fromEntries((units || []).map((u) => [u.sku, u]));
  const qMap = Object.fromEntries((queue || []).map((q) => [q.sku, q]));

  // Best-effort pull of seller SKUs from SP-API search
  let apiItems = [];
  try {
    const path =
      `/listings/2021-08-01/items/${encodeURIComponent(sid)}` +
      `?marketplaceIds=${marketplaceId()}&pageSize=${Math.min(20, limit)}` +
      `&includedData=summaries,attributes,offers,fulfillmentAvailability`;
    // Some regions use /items without seller in path — try seller-scoped search via issues endpoint fallback
    const json = await spapiFetch(
      storeId,
      "GET",
      `/listings/2021-08-01/items?sellerId=${encodeURIComponent(sid)}&marketplaceIds=${marketplaceId()}&pageSize=${Math.min(20, limit)}&includedData=summaries,attributes`,
    ).catch(() => null);
    apiItems = json?.items || [];
  } catch {
    apiItems = [];
  }

  const items = skus.map((sku) => {
    const u = unitMap[sku] || {};
    const q = qMap[sku] || {};
    const f = (floorRows || []).find((r) => r.sku === sku) || {};
    const api = apiItems.find((it) => String(it.sku || "") === sku || String(it.sku || "") === q.offer_sku);
    const priceCents = q.amazon_price_cents ?? u.ask_cents ?? null;
    const title = api?.summaries?.[0]?.itemName || u.title || sku;
    const asin = q.asin || f.listing_id || api?.summaries?.[0]?.asin || null;
    return {
      channel: "amazon",
      sku,
      title,
      asin,
      price_cents: priceCents,
      qty: q.qty_listed ?? 1,
      status: q.status || f.status || "unknown",
      floor_state: u.state || null,
      floor_ask_cents: u.ask_cents ?? null,
      drift:
        priceCents != null && u.ask_cents != null && Math.abs(priceCents - u.ask_cents) > 1
          ? `Amazon price ≠ Floor ask ($${(u.ask_cents / 100).toFixed(2)})`
          : q.status === "not_on_amazon"
            ? q.needs_review_reason || "Not on Amazon — sell elsewhere"
            : null,
      url: asin ? `https://www.amazon.com/dp/${asin}` : null,
      editable: Boolean(q.offer_sku || q.listing_sku) && ["live", "listing", "ready"].includes(q.status || f.status),
      offer_sku: q.offer_sku || q.listing_sku || sku,
    };
  }).filter((row) => {
    if (!query) return true;
    const blob = `${row.sku} ${row.title} ${row.asin || ""}`.toLowerCase();
    return blob.includes(String(query).toLowerCase());
  });

  return { ok: true, items: items.slice(0, limit), api_count: apiItems.length };
}

export async function patchAmazonListing(storeId, { sku, offerSku, priceCents, quantity, syncFloorAsk = true }) {
  const sid = sellerId();
  if (!sid) return { ok: false, error: "AMAZON_SELLER_ID missing" };
  const sb = serviceClient();
  const { data: unit } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  const warn = underFloorWarn(unit, priceCents);
  const sellerSku = offerSku || sku;
  const mp = marketplaceId();
  const attributes = {};
  if (priceCents != null) {
    attributes.purchasable_offer = [
      {
        currency: "USD",
        our_price: [{ schedule: [{ value_with_tax: Number((priceCents / 100).toFixed(2)) }] }],
        marketplace_id: mp,
      },
    ];
  }
  if (quantity != null) {
    attributes.fulfillment_availability = [
      { fulfillment_channel_code: "DEFAULT", quantity: Number(quantity), marketplace_id: mp },
    ];
  }
  // Product type required — use PRODUCT or stored offer_id
  const { data: listing } = await sb
    .from("listings")
    .select("offer_id")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "amazon")
    .maybeSingle();
  const productType = listing?.offer_id || "PRODUCT";
  const path =
    `/listings/2021-08-01/items/${encodeURIComponent(sid)}/${encodeURIComponent(sellerSku)}` +
    `?marketplaceIds=${mp}`;
  const json = await spapiFetch(storeId, "PATCH", path, {
    productType,
    patches: Object.entries(attributes).map(([name, value]) => ({
      op: "replace",
      path: `/attributes/${name}`,
      value,
    })),
  });
  if (syncFloorAsk && priceCents != null) {
    await sb.from("units").update({ ask_cents: priceCents, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("sku", sku);
    await sb
      .from("amazon_list_items")
      .update({ amazon_price_cents: priceCents, updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", sku);
  }
  return { ok: true, warning: warn, submission: json };
}

export async function listEbayListings(storeId = STORE_DEFAULT, { query = "", limit = 50 } = {}) {
  const accounts = await listEbayAccounts(storeId).catch(() => []);
  const connected = (accounts || []).filter((a) => a.status === "connected");
  const sb = serviceClient();
  const items = [];

  for (const account of connected) {
    const label = account.username || account.role || account.id;
    // Inventory API pagination
    let offset = 0;
    let guard = 0;
    while (guard++ < 5) {
      let page;
      try {
        page = await ebayFetch(
          storeId,
          "GET",
          `/sell/inventory/v1/inventory_item?limit=50&offset=${offset}`,
          undefined,
          { accountId: account.id },
        );
      } catch (e) {
        items.push({
          channel: "ebay",
          account: label,
          account_role: account.role,
          sku: null,
          title: null,
          error: e instanceof Error ? e.message : String(e),
          editable: false,
        });
        break;
      }
      for (const inv of page?.inventoryItems || []) {
        const sku = inv.sku;
        const title = inv.product?.title || sku;
        const price = inv.offers?.[0] // not always present
        void price;
        // Fetch offers for price
        let offer = null;
        try {
          const offers = await ebayFetch(
            storeId,
            "GET",
            `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&limit=20`,
            undefined,
            { accountId: account.id },
          );
          offer = (offers?.offers || []).find((o) => o.status === "PUBLISHED") || (offers?.offers || [])[0] || null;
        } catch {
          offer = null;
        }
        const priceCents = offer?.pricingSummary?.price?.value
          ? Math.round(Number(offer.pricingSummary.price.value) * 100)
          : null;
        const itemId = offer?.listing?.listingId || offer?.listingId || null;
        const { data: unit } = await sb
          .from("units")
          .select("sku, title, ask_cents, state")
          .eq("store_id", storeId)
          .eq("sku", sku)
          .maybeSingle();
        items.push({
          channel: "ebay",
          account: label,
          account_id: account.id,
          account_role: account.role,
          sku,
          title: title || unit?.title || sku,
          price_cents: priceCents,
          qty: inv.availability?.shipToLocationAvailability?.quantity ?? null,
          status: offer?.status || "INVENTORY",
          floor_state: unit?.state || null,
          floor_ask_cents: unit?.ask_cents ?? null,
          drift:
            priceCents != null && unit?.ask_cents != null && Math.abs(priceCents - unit.ask_cents) > 1
              ? `eBay price ≠ Floor ask`
              : null,
          url: itemId ? `https://www.ebay.com/itm/${itemId}` : null,
          editable: Boolean(offer?.offerId),
          offer_id: offer?.offerId || null,
          item_id: itemId,
          api: "inventory",
        });
      }
      if (!page?.next || (page?.inventoryItems || []).length < 50) break;
      offset += 50;
    }
  }

  // Trading-era / Vendoo listings may only appear in Floor listings table without Inventory API SKU
  const { data: floorOnly } = await sb
    .from("listings")
    .select("sku, listing_id, status, listed_at")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .eq("status", "listed")
    .limit(100);
  for (const row of floorOnly || []) {
    if (items.some((i) => i.sku === row.sku && i.channel === "ebay")) continue;
    const { data: unit } = await sb
      .from("units")
      .select("title, ask_cents, state")
      .eq("store_id", storeId)
      .eq("sku", row.sku)
      .maybeSingle();
    items.push({
      channel: "ebay",
      account: "unknown / legacy",
      account_role: null,
      sku: row.sku,
      title: unit?.title || row.sku,
      price_cents: unit?.ask_cents ?? null,
      qty: null,
      status: row.status,
      floor_state: unit?.state || null,
      floor_ask_cents: unit?.ask_cents ?? null,
      drift: "Listed on Floor as eBay but not found in Inventory API — likely Trading/Vendoo-era; edit in eBay Seller Hub or migrate",
      url: row.listing_id ? `https://www.ebay.com/itm/${row.listing_id}` : null,
      editable: false,
      api: "legacy_floor_only",
    });
  }

  const filtered = items.filter((row) => {
    if (!query) return true;
    const blob = `${row.sku} ${row.title} ${row.account} ${row.item_id || ""}`.toLowerCase();
    return blob.includes(String(query).toLowerCase());
  });
  return { ok: true, items: filtered.slice(0, limit), accounts: connected.map((a) => ({ id: a.id, username: a.username, role: a.role })) };
}

export async function patchEbayListing(storeId, { accountId, offerId, sku, priceCents, quantity, syncFloorAsk = true }) {
  if (!offerId) return { ok: false, error: "offer_id_required — Inventory API offer missing (legacy/Vendoo listing?)" };
  const hint = accountId ? { accountId } : undefined;
  const offer = await ebayFetch(storeId, "GET", `/sell/inventory/v1/offer/${offerId}`, undefined, hint);
  const body = { ...offer };
  delete body.offerId;
  delete body.listing;
  delete body.status;
  if (priceCents != null) {
    body.pricingSummary = {
      ...(body.pricingSummary || {}),
      price: { value: (priceCents / 100).toFixed(2), currency: "USD" },
    };
  }
  if (quantity != null) {
    body.availableQuantity = Number(quantity);
  }
  await ebayFetch(storeId, "PUT", `/sell/inventory/v1/offer/${offerId}`, body, hint);
  // republish if needed
  try {
    await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${offerId}/publish`, undefined, hint);
  } catch {
    /* already published */
  }
  const sb = serviceClient();
  const { data: unit } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  const warn = underFloorWarn(unit, priceCents);
  if (syncFloorAsk && priceCents != null && sku) {
    await sb.from("units").update({ ask_cents: priceCents, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("sku", sku);
  }
  return { ok: true, warning: warn, offerId };
}

export async function listTikTokListings(storeId = STORE_DEFAULT, { query = "", limit = 50 } = {}) {
  await ensureTikTokTokenFresh(storeId).catch(() => undefined);
  const status = await tiktokConnectionStatus(storeId);
  if (!status.connected && !status.configured) {
    return {
      ok: true,
      items: [],
      stub: true,
      message: "TikTok Shop not connected — set Partner app keys and Authorize in Marketplaces.",
      status,
    };
  }
  let products = [];
  try {
    const json = await tiktokApiFetch(storeId, "POST", "/product/202309/products/search", {
      page_size: Math.min(50, limit),
      status: "ALL",
    });
    products = json?.data?.products || json?.data?.list || json?.products || [];
  } catch (e) {
    return {
      ok: false,
      items: [],
      error: e instanceof Error ? e.message : String(e),
      status,
    };
  }
  const sb = serviceClient();
  const items = [];
  for (const p of products) {
    const sku = String(p.external_sku || p.seller_sku || p.skus?.[0]?.seller_sku || "").trim();
    const title = p.title || p.product_name || sku;
    const priceCents = p.skus?.[0]?.price?.sale_price
      ? Math.round(Number(p.skus[0].price.sale_price) * 100)
      : p.sale_price
        ? Math.round(Number(p.sale_price) * 100)
        : null;
    const { data: unit } = sku
      ? await sb.from("units").select("ask_cents, state, title").eq("store_id", storeId).eq("sku", sku).maybeSingle()
      : { data: null };
    items.push({
      channel: "tiktok",
      sku: sku || null,
      title,
      product_id: p.id || p.product_id,
      price_cents: priceCents,
      qty: p.skus?.[0]?.inventory?.[0]?.quantity ?? p.quantity ?? null,
      status: p.status || p.product_status || "unknown",
      floor_state: unit?.state || null,
      floor_ask_cents: unit?.ask_cents ?? null,
      drift:
        priceCents != null && unit?.ask_cents != null && Math.abs(priceCents - unit.ask_cents) > 1
          ? "TikTok price ≠ Floor ask"
          : null,
      url: null,
      editable: Boolean(p.id || p.product_id),
    });
  }
  const filtered = items.filter((row) => {
    if (!query) return true;
    const blob = `${row.sku} ${row.title}`.toLowerCase();
    return blob.includes(String(query).toLowerCase());
  });
  return { ok: true, items: filtered.slice(0, limit), status };
}

export async function endAmazonListing(storeId, { sku, offerSku }) {
  return patchAmazonListing(storeId, {
    sku,
    offerSku,
    quantity: 0,
    syncFloorAsk: false,
  });
}

export async function endEbayListing(storeId, { accountId, offerId, sku }) {
  if (!offerId) return { ok: false, error: "offer_id_required — Inventory API offer missing (legacy/Vendoo listing?)" };
  const hint = accountId ? { accountId } : undefined;
  try {
    await ebayFetch(
      storeId,
      "POST",
      `/sell/inventory/v1/offer/${offerId}/withdraw`,
      { reasonForWithdrawal: "OTHER" },
      hint,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already|not published|unpublished/i.test(msg)) {
      return { ok: false, error: msg };
    }
  }
  const sb = serviceClient();
  if (sku) {
    await sb
      .from("listings")
      .update({ status: "ended", updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("channel", "ebay")
      .eq("sku", sku);
  }
  return { ok: true, ended: true, offerId, sku };
}

export async function patchTikTokListing(storeId, { productId, sku, priceCents, syncFloorAsk = true }) {
  if (!productId) return { ok: false, error: "product_id_required" };
  // Minimal price update — exact path depends on Partner API version
  const body = {
    product_id: productId,
    skus: priceCents != null ? [{ price: { amount: (priceCents / 100).toFixed(2), currency: "USD" } }] : undefined,
  };
  const json = await tiktokApiFetch(storeId, "PUT", "/product/202309/products", body).catch(async () =>
    tiktokApiFetch(storeId, "POST", "/product/202309/products/partial_edit", body),
  );
  const sb = serviceClient();
  if (syncFloorAsk && priceCents != null && sku) {
    await sb.from("units").update({ ask_cents: priceCents, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("sku", sku);
  }
  return { ok: true, result: json };
}

export { STORE_DEFAULT };
