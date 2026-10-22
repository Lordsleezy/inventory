/**
 * Cross-channel live listing manager (Amazon / eBay / TikTok).
 * Floor remains source of truth for SKU/cost/sold; price edits sync to units.ask_cents when requested.
 * Admin-only (portalAdminFromEvent at the function layer). Never marks units sold on end.
 */
import { serviceClient } from "./server.mjs";
import {
  STORE_DEFAULT,
  spapiFetch,
  marketplaceId,
  suggestAmazonPriceCents,
  prepareAmazonQueueItem,
  listAmazonOffer,
} from "./amazon.mjs";
import { createAmazonCatalogListing } from "./amazon-create.mjs";
import { ebayFetch, listEbayAccounts, listSku, withdrawSku, photoUrls } from "./ebay.mjs";
import {
  tiktokApiFetch,
  tiktokConnectionStatus,
  ensureTikTokTokenFresh,
  prepareTikTokQueueItem,
  listTikTokProduct,
} from "./tiktok-shop.mjs";
import { listLegacyEbayCandidates, migrateEbayListingsToInventory } from "./ebay-inventory-migrate.mjs";

function sellerId() {
  return (process.env.AMAZON_SELLER_ID || "").trim();
}

function syncKey(channel) {
  return `listing_manager_last_sync_${channel}`;
}

async function stampSync(storeId, channel, extra = {}) {
  const sb = serviceClient();
  const value = { at: new Date().toISOString(), ...extra };
  await sb.from("store_settings").upsert(
    { store_id: storeId, key: syncKey(channel), value },
    { onConflict: "store_id,key" },
  );
  return value;
}

async function readSync(storeId, channel) {
  const sb = serviceClient();
  const { data } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", syncKey(channel))
    .maybeSingle();
  return data?.value || null;
}

function underFloorWarn(unit, listCents) {
  if (!unit || listCents == null) return null;
  const price = suggestAmazonPriceCents(unit, 0.15, 0.1);
  void price;
  // Rough: warn if under $5 profit after ~15% fees + cost (shipping/return reserve approximated in fee)
  const cost = Number(unit.acquisition_cost_cents || unit.floor_cents || price.costCents || 0);
  const profit = listCents - cost - Math.round(listCents * 0.15) - Math.round(listCents * 0.1);
  if (profit < 500) {
    return `Price $${(listCents / 100).toFixed(2)} may net under $5 after ~15% fees + ~10% return reserve (profit≈$${(profit / 100).toFixed(2)}). Not blocked — review before saving.`;
  }
  if (unit.ask_cents && listCents < unit.ask_cents) {
    return `Below Floor ask $${(unit.ask_cents / 100).toFixed(2)}.`;
  }
  return null;
}

async function unitPhotos(storeId, sku) {
  const sb = serviceClient();
  const { data } = await sb
    .from("photos")
    .select("path, is_primary")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .order("is_primary", { ascending: false });
  const paths = (data || [])
    .map((r) => r.path)
    .filter((p) => p && !String(p).includes("/official-") && !/ai[-_]?gen/i.test(String(p)));
  const urls = [];
  for (const path of paths.slice(0, 12)) {
    const { data: signed } = await sb.storage.from("unit-photos").createSignedUrl(path, 3600);
    if (signed?.signedUrl) urls.push({ path, url: signed.signedUrl });
  }
  return { paths, urls };
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

  const last_synced = await stampSync(storeId, "amazon", { count: items.length });
  return { ok: true, items: items.slice(0, limit), api_count: apiItems.length, last_synced };
}

export async function patchAmazonListing(
  storeId,
  {
    sku,
    offerSku,
    priceCents,
    quantity,
    title,
    bullets,
    description,
    conditionNote,
    productType: productTypeIn,
    syncFloorAsk = true,
  } = {},
) {
  const sid = sellerId();
  if (!sid) return { ok: false, error: "AMAZON_SELLER_ID missing" };
  const sb = serviceClient();
  const { data: unit } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  const warn = underFloorWarn(unit, priceCents);
  const sellerSku = offerSku || sku;
  const mp = marketplaceId();
  const LANG = "en_US";
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
  if (title) {
    attributes.item_name = [{ value: String(title).slice(0, 200), language_tag: LANG, marketplace_id: mp }];
  }
  if (description) {
    attributes.product_description = [
      { value: String(description).slice(0, 2000), language_tag: LANG, marketplace_id: mp },
    ];
  }
  if (Array.isArray(bullets) && bullets.length) {
    attributes.bullet_point = bullets
      .filter(Boolean)
      .slice(0, 5)
      .map((value) => ({ value: String(value).slice(0, 500), language_tag: LANG, marketplace_id: mp }));
  }
  if (conditionNote) {
    attributes.condition_note = [{ value: String(conditionNote).slice(0, 1000), language_tag: LANG, marketplace_id: mp }];
  }
  if (!Object.keys(attributes).length) return { ok: false, error: "nothing_to_patch" };

  const { data: listing } = await sb
    .from("listings")
    .select("offer_id")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "amazon")
    .maybeSingle();
  const { data: queue } = await sb
    .from("amazon_list_items")
    .select("asin")
    .eq("store_id", storeId)
    .eq("sku", sku)
    .maybeSingle();
  const productType = productTypeIn || listing?.offer_id || "PRODUCT";
  const path =
    `/listings/2021-08-01/items/${encodeURIComponent(sid)}/${encodeURIComponent(sellerSku)}` +
    `?marketplaceIds=${mp}`;
  let json;
  try {
    json = await spapiFetch(storeId, "PATCH", path, {
      productType,
      patches: Object.entries(attributes).map(([name, value]) => ({
        op: "replace",
        path: `/attributes/${name}`,
        value,
      })),
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      httpStatus: e?.status || null,
      body: e?.body || null,
      warning: warn,
      asin: queue?.asin || null,
    };
  }
  if (syncFloorAsk && priceCents != null) {
    await sb.from("units").update({ ask_cents: priceCents, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("sku", sku);
    await sb
      .from("amazon_list_items")
      .update({ amazon_price_cents: priceCents, updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", sku);
  }
  return { ok: true, warning: warn, submission: json, url: queue?.asin ? `https://www.amazon.com/dp/${queue.asin}` : null };
}

export async function listEbayListings(storeId = STORE_DEFAULT, { query = "", limit = 50 } = {}) {
  const accounts = await listEbayAccounts(storeId).catch(() => []);
  const connected = (accounts || []).filter((a) => a.status === "connected");
  const sb = serviceClient();
  const items = [];

  for (const account of connected) {
    const label = account.username || account.role || account.id;
    // orders_only (personal) usually lacks Inventory scopes — skip Inventory scan, still show Floor legacy.
    if (account.role === "orders_only") continue;
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
  const last_synced = await stampSync(storeId, "ebay", { count: filtered.length });
  return {
    ok: true,
    items: filtered.slice(0, limit),
    accounts: connected.map((a) => ({ id: a.id, username: a.username, role: a.role })),
    last_synced,
  };
}

export async function patchEbayListing(
  storeId,
  {
    accountId,
    offerId,
    sku,
    priceCents,
    quantity,
    title,
    description,
    conditionDescription,
    imageUrls,
    aspects,
    syncFloorAsk = true,
  } = {},
) {
  if (!offerId && !sku) return { ok: false, error: "offer_id_or_sku_required" };
  const hint = accountId ? { accountId } : undefined;
  const sb = serviceClient();
  const { data: unit } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  const warn = underFloorWarn(unit, priceCents);

  // Inventory item content (title/desc/photos/aspects)
  const contentTouch = title || description || conditionDescription || (imageUrls && imageUrls.length) || aspects;
  if (contentTouch && sku) {
    let inv;
    try {
      inv = await ebayFetch(storeId, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, undefined, hint);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        hint: "Listing may be Trading/Vendoo-era — migrate to Inventory API first.",
      };
    }
    const product = { ...(inv.product || {}) };
    if (title) product.title = String(title).slice(0, 80);
    if (description) product.description = String(description);
    if (imageUrls?.length) {
      product.imageUrls = imageUrls.filter((u) => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, 12);
      if (!product.imageUrls.length) return { ok: false, error: "image_urls_must_be_https_real_photos" };
    }
    if (aspects && typeof aspects === "object") product.aspects = aspects;
    const putBody = {
      ...inv,
      product,
      ...(conditionDescription
        ? { conditionDescription: String(conditionDescription).slice(0, 1000) }
        : {}),
      ...(quantity != null
        ? {
            availability: {
              ...(inv.availability || {}),
              shipToLocationAvailability: {
                ...(inv.availability?.shipToLocationAvailability || {}),
                quantity: Number(quantity),
              },
            },
          }
        : {}),
    };
    delete putBody.sku;
    try {
      await ebayFetch(storeId, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, putBody, hint);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), body: e?.body || null, warning: warn };
    }
  }

  if (offerId && (priceCents != null || quantity != null)) {
    let offer;
    try {
      offer = await ebayFetch(storeId, "GET", `/sell/inventory/v1/offer/${offerId}`, undefined, hint);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), warning: warn };
    }
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
    if (quantity != null) body.availableQuantity = Number(quantity);
    try {
      await ebayFetch(storeId, "PUT", `/sell/inventory/v1/offer/${offerId}`, body, hint);
      try {
        await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${offerId}/publish`, undefined, hint);
      } catch {
        /* already published */
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), body: e?.body || null, warning: warn };
    }
  }

  if (syncFloorAsk && priceCents != null && sku) {
    await sb.from("units").update({ ask_cents: priceCents, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("sku", sku);
  }
  return { ok: true, warning: warn, offerId, sku };
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
  const last_synced = await stampSync(storeId, "tiktok", { count: filtered.length });
  return { ok: true, items: filtered.slice(0, limit), status, last_synced };
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
  // Prefer Inventory withdraw; fall back to withdrawSku (Trading EndItem) — never marks unit sold.
  if (sku) {
    try {
      await withdrawSku(storeId, sku);
      return { ok: true, ended: true, sku, via: "withdrawSku" };
    } catch (e) {
      if (offerId) {
        /* fall through */
      } else {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
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
      .update({ status: "ended" })
      .eq("store_id", storeId)
      .eq("channel", "ebay")
      .eq("sku", sku);
  }
  return { ok: true, ended: true, offerId, sku, via: "offer_withdraw" };
}

export async function relistEbayListing(storeId, { sku, draft = null, accountId = null, offerId = null } = {}) {
  if (!sku) return { ok: false, error: "sku_required" };
  // Prefer republishing an existing unpublished Inventory offer (keeps migrate path; avoids category gates).
  if (offerId) {
    const hint = accountId ? { accountId } : undefined;
    try {
      const inv = await ebayFetch(storeId, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, undefined, hint);
      const qty = inv?.availability?.shipToLocationAvailability?.quantity ?? 0;
      if (qty < 1) {
        const put = {
          ...inv,
          availability: {
            ...(inv.availability || {}),
            shipToLocationAvailability: {
              ...(inv.availability?.shipToLocationAvailability || {}),
              quantity: 1,
            },
          },
        };
        delete put.sku;
        await ebayFetch(storeId, "PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, put, hint);
      }
      const pub = await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${offerId}/publish`, undefined, hint);
      const listingId = pub?.listingId || null;
      const sb = serviceClient();
      if (listingId) {
        await sb.from("listings").upsert(
          {
            store_id: storeId,
            sku,
            channel: "ebay",
            status: "listed",
            listing_id: String(listingId),
          },
          { onConflict: "store_id,sku,channel" },
        );
      }
      return {
        ok: true,
        relisted: true,
        via: "offer_publish",
        listingId,
        url: listingId ? `https://www.ebay.com/itm/${listingId}` : null,
        note: "Republish may assign a new eBay item id; prior views/watchers on the old id are not carried over.",
      };
    } catch (e) {
      /* fall through to listSku */
      void e;
    }
  }
  try {
    const result = await listSku(storeId, sku, draft);
    return { ok: true, relisted: true, via: "listSku", ...result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function patchTikTokListing(
  storeId,
  { productId, sku, priceCents, title, description, syncFloorAsk = true } = {},
) {
  if (!productId) return { ok: false, error: "product_id_required" };
  const body = {
    product_id: productId,
  };
  if (title) body.title = String(title).slice(0, 255);
  if (description) body.description = String(description).slice(0, 5000);
  if (priceCents != null) {
    body.skus = [{ price: { amount: (priceCents / 100).toFixed(2), currency: "USD" } }];
  }
  let json;
  try {
    json = await tiktokApiFetch(storeId, "POST", "/product/202309/products/partial_edit", body);
  } catch {
    try {
      json = await tiktokApiFetch(storeId, "PUT", "/product/202309/products", body);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  if (json?.code != null && Number(json.code) !== 0) {
    return { ok: false, error: json.message || json.msg || `tiktok_code_${json.code}`, result: json };
  }
  const sb = serviceClient();
  const { data: unit } = sku
    ? await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle()
    : { data: null };
  const warn = underFloorWarn(unit, priceCents);
  if (syncFloorAsk && priceCents != null && sku) {
    await sb.from("units").update({ ask_cents: priceCents, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("sku", sku);
  }
  return { ok: true, warning: warn, result: json };
}

export async function endTikTokListing(storeId, { productId, sku }) {
  if (!productId) return { ok: false, error: "product_id_required" };
  let json;
  try {
    json = await tiktokApiFetch(storeId, "POST", "/product/202309/products/deactivate", {
      product_ids: [productId],
    });
  } catch (e) {
    try {
      json = await tiktokApiFetch(storeId, "DELETE", `/product/202309/products/${encodeURIComponent(productId)}`);
    } catch (e2) {
      return { ok: false, error: e2 instanceof Error ? e2.message : String(e2) };
    }
  }
  const sb = serviceClient();
  if (sku) {
    await sb
      .from("listings")
      .update({ status: "ended" })
      .eq("store_id", storeId)
      .eq("channel", "tiktok")
      .eq("sku", sku);
    await sb
      .from("tiktok_list_items")
      .update({ status: "removed", updated_at: new Date().toISOString() })
      .eq("store_id", storeId)
      .eq("sku", sku);
  }
  return { ok: true, ended: true, productId, sku, result: json };
}

/** Floor units eligible to add to a channel (available, priced, has real photos, not already live). */
export async function listEligibleUnits(storeId, { channel, query = "", limit = 40 } = {}) {
  const sb = serviceClient();
  const ch = String(channel || "").toLowerCase();
  const { data: units, error } = await sb
    .from("units")
    .select("sku, title, brand, model, ask_cents, condition, state, upc, listing_body")
    .eq("store_id", storeId)
    .eq("state", "available")
    .gt("ask_cents", 0)
    .order("sku", { ascending: false })
    .limit(300);
  if (error) return { ok: false, error: error.message, items: [] };
  const qLower = String(query || "").trim().toLowerCase();
  const filteredUnits = qLower
    ? (units || []).filter((u) =>
        `${u.sku} ${u.title || ""} ${u.brand || ""} ${u.model || ""} ${u.upc || ""}`.toLowerCase().includes(qLower),
      )
    : units || [];

  const listed = new Set();
  if (ch === "ebay") {
    const { data } = await sb
      .from("listings")
      .select("sku")
      .eq("store_id", storeId)
      .eq("channel", "ebay")
      .eq("status", "listed");
    for (const r of data || []) listed.add(r.sku);
  } else if (ch === "amazon") {
    const { data } = await sb
      .from("amazon_list_items")
      .select("sku, status")
      .eq("store_id", storeId)
      .in("status", ["live", "listing", "ready", "queued", "needs_review"]);
    for (const r of data || []) listed.add(r.sku);
  } else if (ch === "tiktok") {
    const { data } = await sb
      .from("tiktok_list_items")
      .select("sku, status")
      .eq("store_id", storeId)
      .in("status", ["live", "ready", "queued"]);
    for (const r of data || []) listed.add(r.sku);
  }

  const items = [];
  for (const u of filteredUnits) {
    if (listed.has(u.sku)) continue;
    const photos = await unitPhotos(storeId, u.sku);
    if (!photos.paths.length) continue;
    items.push({
      sku: u.sku,
      title: u.title,
      brand: u.brand,
      model: u.model,
      ask_cents: u.ask_cents,
      condition: u.condition,
      upc: u.upc,
      photo_count: photos.paths.length,
      thumb: photos.urls[0]?.url || null,
    });
    if (items.length >= limit) break;
  }
  return { ok: true, channel: ch, items };
}

/** Prefill create draft from Floor (no marketplace write). */
export async function prefillCreate(storeId, { channel, sku } = {}) {
  const sb = serviceClient();
  const { data: unit, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!unit) return { ok: false, error: "unknown_sku" };
  if (unit.state !== "available" && unit.state !== "reserved") {
    return { ok: false, error: `unit_not_sellable:${unit.state}` };
  }
  const photos = await unitPhotos(storeId, sku);
  if (!photos.paths.length) return { ok: false, error: "photos_required — real unit photos only (no AI)" };

  const ch = String(channel || "").toLowerCase();
  const base = {
    channel: ch,
    sku,
    title: unit.title || `SKU ${sku}`,
    brand: unit.brand,
    model: unit.model,
    description: unit.listing_body || unit.title || "",
    condition: unit.condition,
    condition_note: unit.defect_notes || "",
    price_cents: unit.ask_cents,
    upc: unit.upc,
    photos: photos.urls,
    photo_paths: photos.paths,
  };

  if (ch === "ebay") {
    let ebayPhotos = [];
    try {
      ebayPhotos = await photoUrls(storeId, sku);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return {
      ok: true,
      draft: {
        ...base,
        image_urls: ebayPhotos,
        account: "ikonikdeals2026 (selling)",
        note: "Publishes via Inventory API on the selling account with business policies.",
      },
    };
  }
  if (ch === "amazon") {
    const prep = await prepareAmazonQueueItem(storeId, sku);
    return {
      ok: true,
      draft: {
        ...base,
        asin: prep.asin || null,
        status: prep.status,
        needs_review_reason: prep.needs_review_reason || null,
        product_type: "STRING_LIGHT",
        note:
          prep.status === "not_on_amazon"
            ? "Create blocked (GS1/brand). Marked Not on Amazon — sell elsewhere."
            : prep.asin
              ? "ASIN matched — publish creates an offer on the existing catalog product."
              : "No ASIN — publish runs create VALIDATION_PREVIEW then live create if clean.",
      },
      prepare: prep,
    };
  }
  if (ch === "tiktok") {
    const prep = await prepareTikTokQueueItem(storeId, sku);
    return {
      ok: true,
      draft: {
        ...base,
        prepare_ok: prep.ok,
        prepare_status: prep.status,
        note: prep.ok
          ? "Ready to create on TikTok Shop (needs Partner keys + OAuth)."
          : prep.last_error || "Not ready — check TikTok connection / eligibility.",
      },
      prepare: prep,
    };
  }
  return { ok: false, error: "channel_required" };
}

/** Publish a new listing from Floor (live marketplace write). */
export async function publishCreate(
  storeId,
  { channel, sku, title, description, priceCents, imageUrls, aspects, confirmCreate = false } = {},
) {
  const ch = String(channel || "").toLowerCase();
  const sb = serviceClient();
  const { data: unit } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (!unit) return { ok: false, error: "unknown_sku" };
  const warn = underFloorWarn(unit, priceCents ?? unit.ask_cents);

  if (ch === "ebay") {
    try {
      const result = await listSku(storeId, sku, {
        title: title || undefined,
        description: description || undefined,
        priceCents: priceCents ?? undefined,
        imageUrls: imageUrls?.length ? imageUrls : undefined,
        aspects: aspects || undefined,
      });
      return {
        ok: true,
        channel: "ebay",
        sku,
        warning: warn,
        url: result?.listingId ? `https://www.ebay.com/itm/${result.listingId}` : null,
        result,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), warning: warn };
    }
  }

  if (ch === "amazon") {
    const prep = await prepareAmazonQueueItem(storeId, sku);
    if (prep.status === "not_on_amazon") {
      return { ok: false, error: "not_on_amazon", message: prep.needs_review_reason, prepare: prep };
    }
    if (prep.asin && (prep.status === "ready" || prep.status === "needs_review" || prep.status === "error")) {
      try {
        const listed = await listAmazonOffer(storeId, {
          unit,
          sku,
          asin: prep.asin,
          priceCents: priceCents || prep.amazon_price_cents || unit.ask_cents,
        });
        return {
          ok: Boolean(listed?.ok),
          channel: "amazon",
          sku,
          asin: prep.asin,
          warning: warn,
          url: prep.asin ? `https://www.amazon.com/dp/${prep.asin}` : null,
          error: listed?.ok ? null : listed?.message || listed?.reason,
          result: listed,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), warning: warn };
      }
    }
    // No ASIN — create path
    const preview = await createAmazonCatalogListing(storeId, sku, {
      mode: "VALIDATION_PREVIEW",
      overrides: { price_cents: priceCents || null },
    });
    if (!preview.ok) {
      return {
        ok: false,
        error: preview.reason || "create_preview_failed",
        message: preview.message,
        preview,
        warning: warn,
      };
    }
    if (!confirmCreate) {
      return {
        ok: true,
        needs_confirm: true,
        message: "VALIDATION_PREVIEW clean — pass confirm_create=true to submit live (needs Amazon-hosted main image).",
        preview,
        warning: warn,
      };
    }
    const live = await createAmazonCatalogListing(storeId, sku, {
      mode: "LIVE",
      confirmLive: true,
      overrides: { price_cents: priceCents || null },
    });
    return { ok: Boolean(live.ok), channel: "amazon", sku, result: live, warning: warn };
  }

  if (ch === "tiktok") {
    const listed = await listTikTokProduct(storeId, { unit, sku, priceCents });
    return {
      ok: Boolean(listed?.ok),
      channel: "tiktok",
      sku,
      warning: warn,
      product_id: listed?.product_id || null,
      error: listed?.ok ? null : listed?.message || listed?.reason,
      result: listed,
    };
  }
  return { ok: false, error: "channel_required" };
}

export async function getListingDetail(storeId, { channel, sku, offerId, accountId, productId } = {}) {
  const ch = String(channel || "").toLowerCase();
  const sb = serviceClient();
  const { data: unit } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  const photos = sku ? await unitPhotos(storeId, sku) : { urls: [], paths: [] };

  if (ch === "ebay" && sku) {
    const hint = accountId ? { accountId } : undefined;
    let inv = null;
    let offer = null;
    try {
      inv = await ebayFetch(storeId, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, undefined, hint);
    } catch (e) {
      return {
        ok: false,
        editable: false,
        api: "legacy_or_missing",
        error: e instanceof Error ? e.message : String(e),
        unit,
        photos: photos.urls,
      };
    }
    if (offerId) {
      try {
        offer = await ebayFetch(storeId, "GET", `/sell/inventory/v1/offer/${offerId}`, undefined, hint);
      } catch {
        offer = null;
      }
    }
    return {
      ok: true,
      channel: "ebay",
      editable: true,
      api: "inventory",
      title: inv?.product?.title || unit?.title,
      description: inv?.product?.description || unit?.listing_body,
      image_urls: inv?.product?.imageUrls || [],
      aspects: inv?.product?.aspects || {},
      condition_description: inv?.conditionDescription || "",
      price_cents: offer?.pricingSummary?.price?.value
        ? Math.round(Number(offer.pricingSummary.price.value) * 100)
        : unit?.ask_cents,
      qty: inv?.availability?.shipToLocationAvailability?.quantity ?? 1,
      offer_id: offerId || offer?.offerId,
      item_id: offer?.listing?.listingId || null,
      unit,
      photos: photos.urls,
    };
  }

  if (ch === "amazon") {
    const { data: queue } = await sb.from("amazon_list_items").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
    return {
      ok: true,
      channel: "amazon",
      editable: Boolean(queue?.offer_sku || queue?.listing_sku),
      title: unit?.title,
      description: unit?.listing_body,
      price_cents: queue?.amazon_price_cents ?? unit?.ask_cents,
      qty: queue?.qty_listed ?? 1,
      asin: queue?.asin,
      offer_sku: queue?.offer_sku || queue?.listing_sku,
      condition_note: queue?.condition_note,
      unit,
      photos: photos.urls,
    };
  }

  if (ch === "tiktok") {
    return {
      ok: true,
      channel: "tiktok",
      editable: Boolean(productId),
      title: unit?.title,
      description: unit?.listing_body,
      price_cents: unit?.ask_cents,
      product_id: productId,
      unit,
      photos: photos.urls,
    };
  }
  return { ok: false, error: "channel_required" };
}

export async function queueBulkPublish(storeId, { channel, skus = [], requestedBy = "portal" } = {}) {
  const list = [...new Set((skus || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 25);
  if (!list.length) return { ok: false, error: "skus_required" };
  const sb = serviceClient();
  const value = {
    status: "queued",
    channel,
    skus: list,
    requested_at: new Date().toISOString(),
    requested_by: requestedBy,
    results: [],
    progress: { current: 0, total: list.length, message: "Queued — paced publish starting…" },
  };
  await sb.from("store_settings").upsert(
    { store_id: storeId, key: "listing_manager_bulk_publish", value },
    { onConflict: "store_id,key" },
  );
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const token = process.env.SUPABASE_SERVICE_ROLE;
  const res = await fetch(`${base}/.netlify/functions/listing-manager-background`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ job: "bulk_publish", store_id: storeId, channel, skus: list, requested_by: requestedBy }),
  });
  const ok = res.ok || res.status === 202;
  return {
    ok,
    started: ok,
    message: ok
      ? `Bulk publish started for ${list.length} SKU(s) on ${channel} (paced).`
      : `Dispatch failed: ${(await res.text()).slice(0, 200)}`,
    skus: list,
  };
}

export async function getBulkPublishStatus(storeId) {
  const sb = serviceClient();
  const { data } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", "listing_manager_bulk_publish")
    .maybeSingle();
  return data?.value || null;
}

export async function runBulkPublish(storeId, { channel, skus = [] } = {}) {
  const sb = serviceClient();
  const results = [];
  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];
    await sb.from("store_settings").upsert(
      {
        store_id: storeId,
        key: "listing_manager_bulk_publish",
        value: {
          status: "running",
          channel,
          skus,
          progress: {
            current: i + 1,
            total: skus.length,
            message: `Publishing ${sku} (${i + 1}/${skus.length})…`,
          },
          results,
          updated_at: new Date().toISOString(),
        },
      },
      { onConflict: "store_id,key" },
    );
    const published = await publishCreate(storeId, { channel, sku });
    results.push({ sku, ok: Boolean(published.ok), error: published.error || null, url: published.url || null });
    // Pace ~8–12s between publishes so it doesn't look like a bot dump
    if (i < skus.length - 1) await new Promise((r) => setTimeout(r, 9000 + Math.floor(Math.random() * 3000)));
  }
  const summary = { total: skus.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
  const final = {
    status: "completed",
    channel,
    skus,
    results,
    summary,
    finished_at: new Date().toISOString(),
    progress: { current: skus.length, total: skus.length, message: `Done · ${summary.ok}/${summary.total} published` },
  };
  await sb.from("store_settings").upsert(
    { store_id: storeId, key: "listing_manager_bulk_publish", value: final },
    { onConflict: "store_id,key" },
  );
  return final;
}

export {
  listLegacyEbayCandidates,
  migrateEbayListingsToInventory,
  readSync,
  stampSync,
};

export { STORE_DEFAULT };
