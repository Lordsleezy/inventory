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
import { ebayFetch, listEbayAccounts, loadEbayAccount, listSku, withdrawSku, photoUrls } from "./ebay.mjs";
import { resolveEbayAccount, userTokenForAccount } from "./ebay-accounts.mjs";
import { getMyEbaySellingActive, getSellerListActive, reviseTradingFixedPrice } from "./ebay-trading.mjs";
import {
  tiktokApiFetch,
  tiktokConnectionStatus,
  ensureTikTokTokenFresh,
  prepareTikTokQueueItem,
  listTikTokProduct,
} from "./tiktok-shop.mjs";
import {
  LISTING_MANAGER_LIMIT,
  amazonIsLive,
  amazonRowFromFloor,
  amazonRowFromSearchItem,
  depopRowFromFloor,
  ebayRowFromActive,
  listingMatches,
  mergeEbayListings,
  tiktokIsLive,
  tiktokRowFromProduct,
} from "./listing-manager-rows.mjs";
import { listLegacyEbayCandidates, migrateEbayListingsToInventory } from "./ebay-inventory-migrate.mjs";
import { calcListPrice, estimateLabelCost, getFeeConfig } from "./marketplace-pricing.mjs";
import { composeChannelDescription, parseListingSpecs } from "./listing-copy.mjs";
import { channelGaps } from "./listing-requirements.mjs";
import { prepareUnitAspects } from "./ebay-catalog.mjs";

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

async function unitsBySku(storeId, skus) {
  const sb = serviceClient();
  const map = {};
  const list = [...new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const { data, error } = await sb
      .from("units")
      .select("sku, title, ask_cents, state, brand, listing_specs")
      .eq("store_id", storeId)
      .in("sku", chunk);
    if (error) throw new Error(error.message);
    for (const row of data || []) map[row.sku] = row;
  }
  return map;
}

async function pullAmazonSearchItems(storeId, sid) {
  const items = [];
  let pageToken = "";
  for (let page = 0; page < 40; page += 1) {
    const qs = new URLSearchParams({
      marketplaceIds: marketplaceId(),
      pageSize: "20",
      includedData: "summaries,offers,fulfillmentAvailability",
    });
    if (pageToken) qs.set("pageToken", pageToken);
    const json = await spapiFetch(
      storeId,
      "GET",
      `/listings/2021-08-01/items/${encodeURIComponent(sid)}?${qs.toString()}`,
    );
    const batch = json?.items || [];
    items.push(...batch);
    pageToken = json?.pagination?.nextToken || "";
    if (!pageToken || !batch.length) break;
  }
  return items;
}

export async function listAmazonListings(storeId = STORE_DEFAULT, { query = "", limit = LISTING_MANAGER_LIMIT } = {}) {
  const sid = sellerId();
  const sb = serviceClient();
  const { data: floorRows, error: floorError } = await sb
    .from("listings")
    .select("sku, status, listing_id, offer_id, listed_at")
    .eq("store_id", storeId)
    .eq("channel", "amazon")
    .in("status", ["listed", "live", "listing"])
    .limit(LISTING_MANAGER_LIMIT);
  if (floorError) return { ok: false, error: floorError.message, items: [] };
  const { data: queue, error: queueError } = await sb
    .from("amazon_list_items")
    .select("sku, asin, status, amazon_price_cents, listing_sku, offer_sku, qty_listed, needs_review_reason")
    .eq("store_id", storeId)
    .neq("status", "removed")
    .limit(LISTING_MANAGER_LIMIT);
  if (queueError) return { ok: false, error: queueError.message, items: [] };
  const qMap = Object.fromEntries((queue || []).map((row) => [row.sku, row]));
  const floorMap = Object.fromEntries((floorRows || []).filter((row) => row.sku).map((row) => [row.sku, row]));

  let apiItems = [];
  let apiError = null;
  if (!sid) apiError = "AMAZON_SELLER_ID missing";
  else {
    try {
      apiItems = await pullAmazonSearchItems(storeId, sid);
    } catch (e) {
      apiError = e instanceof Error ? e.message : String(e);
      apiItems = [];
    }
  }
  const liveApi = apiItems.filter(amazonIsLive);
  const skus = [
    ...new Set([
      ...liveApi.map((item) => item.sku),
      ...(floorRows || []).map((row) => row.sku),
      ...(queue || []).map((row) => row.sku),
    ]),
  ];
  const unitMap = await unitsBySku(storeId, skus);
  const seen = new Set();
  const items = [];
  for (const item of liveApi) {
    const sku = item.sku || null;
    if (sku) seen.add(sku);
    items.push(amazonRowFromSearchItem(item, sku ? unitMap[sku] : null, sku ? qMap[sku] : null, sku ? floorMap[sku] : null));
  }
  for (const sku of skus) {
    if (!sku || seen.has(sku)) continue;
    const q = qMap[sku];
    const floor = floorMap[sku];
    if (!floor && (!q || q.status === "not_on_amazon")) continue;
    seen.add(sku);
    items.push(amazonRowFromFloor(sku, unitMap[sku], q, floor));
  }
  const filtered = items.filter((row) => listingMatches(row, query));
  const capped = filtered.slice(0, limit);
  const warnings = [];
  if (apiError) warnings.push(apiError);
  const last_synced = await stampSync(storeId, "amazon", { count: filtered.length, live: liveApi.length, api_error: apiError });
  if (!capped.length && apiError && !(floorRows || []).length) {
    return { ok: false, error: apiError, items: [], warnings, last_synced };
  }
  return {
    ok: true,
    items: capped,
    total: filtered.length,
    live_count: liveApi.length,
    api_count: apiItems.length,
    warnings,
    truncated: filtered.length > capped.length,
    last_synced,
  };
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

async function pullEbayActive(storeId, account) {
  const full = await loadEbayAccount(storeId, { id: account.id });
  const token = await userTokenForAccount(full);
  const active = await getMyEbaySellingActive(token, { entriesPerPage: 200, maxPages: 20 });
  if (active.length) return { rows: active, source: "active_list" };
  // ActiveList can come back empty for a seller who still has live listings. Seller list is the backup.
  try {
    const seller = await getSellerListActive(token, { entriesPerPage: 200, maxPages: 20 });
    if (seller.length) return { rows: seller, source: "seller_list" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { rows: [], source: "active_list", error: `ActiveList was empty and GetSellerList failed: ${message}` };
  }
  return { rows: [], source: "active_list" };
}

export async function listEbayListings(storeId = STORE_DEFAULT, { query = "", limit = LISTING_MANAGER_LIMIT } = {}) {
  const accounts = await listEbayAccounts(storeId).catch(() => []);
  const connected = (accounts || []).filter((a) => a.status === "connected");
  const sb = serviceClient();
  const pulled = await Promise.all(
    connected.map(async (account) => {
      try {
        const pulled = await pullEbayActive(storeId, account);
        return { account, rows: pulled.rows, source: pulled.source, error: pulled.error || null };
      } catch (e) {
        return { account, rows: [], source: null, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  const { data: floorRows, error: floorError } = await sb
    .from("listings")
    .select("sku, listing_id, status, listed_at, ebay_account_id")
    .eq("store_id", storeId)
    .eq("channel", "ebay")
    .eq("status", "listed")
    .limit(LISTING_MANAGER_LIMIT);
  if (floorError) return { ok: false, error: floorError.message, items: [] };

  const live = [];
  for (const bag of pulled) {
    for (const row of bag.rows) {
      const status = String(row.listingStatus || "Active").toLowerCase();
      if (status && status !== "active") continue;
      live.push(ebayRowFromActive(bag.account, row, null));
    }
  }
  const skuList = [
    ...live.map((row) => row.sku),
    ...(floorRows || []).map((row) => row.sku),
  ];
  const unitMap = await unitsBySku(storeId, skuList);
  const liveWithFloor = live.map((row) => {
    const unit = row.sku ? unitMap[row.sku] : null;
    if (!unit) return row;
    return ebayRowFromActive(
      { id: row.account_id, username: row.account, role: row.account_role },
      {
        itemId: row.item_id,
        sku: row.sku,
        title: row.title,
        currentPrice: row.price_cents != null ? (row.price_cents / 100).toFixed(2) : "",
        quantity: row.qty ?? 0,
        quantitySold: 0,
        listingStatus: row.status,
        viewItemUrl: row.url,
      },
      unit,
    );
  });
  const accountById = Object.fromEntries(connected.map((account) => [account.id, account]));
  const merged = mergeEbayListings(liveWithFloor, floorRows || [], unitMap, accountById);
  const filtered = merged.filter((row) => listingMatches(row, query));
  const capped = filtered.slice(0, limit);
  const warnings = pulled.filter((bag) => bag.error).map((bag) => `${bag.account.username || bag.account.role}: ${bag.error}`);
  const accountSummary = pulled.map((bag) => ({
    id: bag.account.id,
    username: bag.account.username,
    role: bag.account.role,
    live_count: bag.rows.filter((row) => String(row.listingStatus || "Active").toLowerCase() === "active" || !row.listingStatus).length,
    error: bag.error,
  }));
  const last_synced = await stampSync(storeId, "ebay", {
    count: filtered.length,
    live: live.length,
    accounts: accountSummary.map((row) => ({ username: row.username, live_count: row.live_count, error: row.error })),
  });
  if (!capped.length && warnings.length && !(floorRows || []).length) {
    return { ok: false, error: warnings.join(" · "), items: [], accounts: accountSummary, warnings, last_synced };
  }
  return {
    ok: true,
    items: capped,
    total: filtered.length,
    live_count: live.length,
    accounts: accountSummary,
    warnings,
    truncated: filtered.length > capped.length,
    last_synced,
  };
}

function numericItemId(value) {
  const id = String(value || "").trim();
  return /^\d+$/.test(id) ? id : null;
}

async function reviseTradingEraListing(storeId, { accountId, itemId, priceCents, quantity, title, description, conditionDescription, imageUrls, aspects }) {
  const tradingId = numericItemId(itemId);
  if (!tradingId) {
    return {
      ok: false,
      error: "trading_item_id_required",
      hint: "Listing may be Trading/Vendoo-era — migrate to Inventory API first.",
    };
  }
  const account = await resolveEbayAccount(storeId, accountId ? { accountId } : { role: "selling" });
  const token = await userTokenForAccount(account);
  const revised = await reviseTradingFixedPrice(token, {
    itemId: tradingId,
    price: priceCents != null ? priceCents / 100 : null,
    quantity,
    title,
    description,
    conditionDescription,
    pictureUrls: imageUrls,
    aspects,
  });
  return { ok: true, via: "trading", itemId: tradingId, ack: revised.ack };
}

export async function patchEbayListing(
  storeId,
  {
    accountId,
    offerId,
    itemId,
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
  if (!offerId && !sku && !itemId) return { ok: false, error: "offer_id_or_sku_required" };
  const hint = accountId ? { accountId } : undefined;
  const sb = serviceClient();
  const { data: unit } = sku
    ? await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle()
    : { data: null };
  const warn = underFloorWarn(unit, priceCents);
  const tradingId = numericItemId(itemId);

  // Inventory item content (title/desc/photos/aspects). A miss means Trading/Vendoo.
  const contentTouch = title || description || conditionDescription || (imageUrls && imageUrls.length) || aspects;
  let inventoryFound = false;
  if (contentTouch && sku) {
    let inv;
    try {
      inv = await ebayFetch(storeId, "GET", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, undefined, hint);
      inventoryFound = true;
    } catch (e) {
      if (!tradingId) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          hint: "Listing may be Trading/Vendoo-era — migrate to Inventory API first.",
          warning: warn,
        };
      }
    }
    if (inventoryFound) {
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
  }

  let priced = false;
  let resolvedOfferId = offerId || null;
  if (!resolvedOfferId && sku && (priceCents != null || quantity != null)) {
    const found = await ebayFetch(
      storeId,
      "GET",
      `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,
      undefined,
      hint,
    ).catch(() => null);
    resolvedOfferId = found?.offers?.[0]?.offerId || null;
  }
  if (resolvedOfferId && (priceCents != null || quantity != null)) {
    let offer;
    try {
      offer = await ebayFetch(storeId, "GET", `/sell/inventory/v1/offer/${resolvedOfferId}`, undefined, hint);
    } catch (e) {
      if (!tradingId || inventoryFound) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), warning: warn };
      }
      offer = null;
    }
    if (offer) {
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
        await ebayFetch(storeId, "PUT", `/sell/inventory/v1/offer/${resolvedOfferId}`, body, hint);
        priced = true;
        try {
          await ebayFetch(storeId, "POST", `/sell/inventory/v1/offer/${resolvedOfferId}/publish`, undefined, hint);
        } catch {
          /* already published */
        }
      } catch (e) {
        if (!tradingId || inventoryFound) {
          return { ok: false, error: e instanceof Error ? e.message : String(e), body: e?.body || null, warning: warn };
        }
      }
    }
  }

  const needTrading = (contentTouch && !inventoryFound) || ((priceCents != null || quantity != null) && !priced);
  let via = inventoryFound || priced ? "inventory" : null;
  if (needTrading) {
    if (!tradingId && (priceCents != null || quantity != null) && !priced) {
      return { ok: false, error: "no_ebay_offer_or_item_id", warning: warn };
    }
    if (tradingId) {
      try {
        const revised = await reviseTradingEraListing(storeId, {
          accountId,
          itemId: tradingId,
          priceCents: priced ? null : priceCents,
          quantity: priced ? null : quantity,
          title: inventoryFound ? null : title,
          description: inventoryFound ? null : description,
          conditionDescription: inventoryFound ? null : conditionDescription,
          imageUrls: inventoryFound ? null : imageUrls,
          aspects: inventoryFound ? null : aspects,
        });
        if (!revised.ok) return { ...revised, warning: warn };
        via = "trading";
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e), via: "trading", warning: warn };
      }
    }
  }

  if (syncFloorAsk && priceCents != null && sku) {
    await sb.from("units").update({ ask_cents: priceCents, updated_at: new Date().toISOString() }).eq("store_id", storeId).eq("sku", sku);
  }
  return { ok: true, warning: warn, offerId: resolvedOfferId || offerId, sku, itemId: tradingId, via };
}

async function pullTikTokProducts(storeId) {
  const products = [];
  let pageToken = "";
  for (let page = 0; page < 20; page += 1) {
    const json = await tiktokApiFetch(
      storeId,
      "POST",
      "/product/202309/products/search",
      { status: "ACTIVATE" },
      { page_size: "100", ...(pageToken ? { page_token: pageToken } : {}) },
    );
    if (json?.code != null && Number(json.code) !== 0) {
      throw new Error(json.message || json.msg || `tiktok_code_${json.code}`);
    }
    const batch = json?.data?.products || json?.data?.list || json?.products || [];
    products.push(...batch);
    pageToken = json?.data?.next_page_token || "";
    if (!pageToken || !batch.length) break;
  }
  return products;
}

export async function listTikTokListings(storeId = STORE_DEFAULT, { query = "", limit = LISTING_MANAGER_LIMIT } = {}) {
  await ensureTikTokTokenFresh(storeId).catch(() => undefined);
  const status = await tiktokConnectionStatus(storeId);
  const sb = serviceClient();
  const { data: floorRows, error: floorError } = await sb
    .from("listings")
    .select("sku, listing_id, status, listed_at")
    .eq("store_id", storeId)
    .eq("channel", "tiktok")
    .eq("status", "listed")
    .limit(LISTING_MANAGER_LIMIT);
  if (floorError) return { ok: false, error: floorError.message, items: [] };

  let products = [];
  let apiError = null;
  if (!status.connected && !status.configured) {
    apiError = "TikTok Shop not connected — set Partner app keys and Authorize in Marketplaces.";
  } else {
    try {
      products = await pullTikTokProducts(storeId);
    } catch (e) {
      apiError = e instanceof Error ? e.message : String(e);
    }
  }
  const liveProducts = products.filter((product) => tiktokIsLive(product?.status || product?.product_status || "ACTIVATE"));
  const skus = [
    ...liveProducts.map((product) => product?.skus?.[0]?.seller_sku || product?.external_sku || product?.seller_sku),
    ...(floorRows || []).map((row) => row.sku),
  ];
  const unitMap = await unitsBySku(storeId, skus);
  const seen = new Set();
  const items = [];
  for (const product of liveProducts) {
    const row = tiktokRowFromProduct(product, null);
    const unit = row.sku ? unitMap[row.sku] : null;
    const shaped = unit ? tiktokRowFromProduct(product, unit) : row;
    if (shaped.sku) seen.add(shaped.sku);
    if (shaped.product_id) seen.add(`id:${shaped.product_id}`);
    items.push(shaped);
  }
  for (const floor of floorRows || []) {
    if (floor.sku && seen.has(floor.sku)) continue;
    if (floor.listing_id && seen.has(`id:${floor.listing_id}`)) continue;
    const unit = floor.sku ? unitMap[floor.sku] : null;
    items.push({
      channel: "tiktok",
      sku: floor.sku,
      title: unit?.title || floor.sku,
      product_id: floor.listing_id || null,
      price_cents: unit?.ask_cents ?? null,
      qty: null,
      status: floor.status,
      floor_state: unit?.state || null,
      floor_ask_cents: unit?.ask_cents ?? null,
      drift: "On Floor as listed, not in the live TikTok catalog",
      url: null,
      editable: Boolean(floor.listing_id),
      api: "floor",
    });
  }
  const filtered = items.filter((row) => listingMatches(row, query));
  const capped = filtered.slice(0, limit);
  const warnings = apiError ? [apiError] : [];
  const last_synced = await stampSync(storeId, "tiktok", { count: filtered.length, live: liveProducts.length, api_error: apiError });
  if (!capped.length && apiError) {
    return {
      ok: true,
      items: [],
      stub: !status.connected,
      message: apiError,
      warnings,
      status,
      last_synced,
    };
  }
  return {
    ok: true,
    items: capped,
    total: filtered.length,
    live_count: liveProducts.length,
    warnings,
    status,
    truncated: filtered.length > capped.length,
    last_synced,
  };
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

/** Normalize a Depop product URL → stable listing_id (path after /products/). */
export function parseDepopListingRef(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "depop_url_required" };
  if (/^listed$/i.test(raw)) return { ok: true, listingId: null, url: null, markedOnly: true };
  let url = raw;
  if (!/^https?:\/\//i.test(url)) {
    if (url.startsWith("depop.com/") || url.startsWith("www.depop.com/")) url = `https://${url}`;
    else if (url.startsWith("/products/")) url = `https://www.depop.com${url}`;
  }
  try {
    const u = new URL(url);
    if (!/\.depop\.com$/i.test(u.hostname) && !/^depop\.com$/i.test(u.hostname)) {
      return { ok: false, error: "url_must_be_depop_com" };
    }
    const m = u.pathname.match(/\/products\/([^/?#]+)/i);
    if (!m) return { ok: false, error: "depop_url_needs_products_path" };
    const listingId = m[1];
    return { ok: true, listingId, url: `https://www.depop.com/products/${listingId}/`, markedOnly: false };
  } catch {
    return { ok: false, error: "invalid_depop_url" };
  }
}

/** Floor Depop listings (no live API — rows confirmed via Push to Depop). */
export async function listDepopListings(storeId = STORE_DEFAULT, { query = "", limit = LISTING_MANAGER_LIMIT } = {}) {
  const sb = serviceClient();
  const { data: rows, error } = await sb
    .from("listings")
    .select("sku, listing_id, status, listed_at, delisted_at")
    .eq("store_id", storeId)
    .eq("channel", "depop")
    .eq("status", "listed")
    .order("listed_at", { ascending: false })
    .limit(LISTING_MANAGER_LIMIT);
  if (error) return { ok: false, error: error.message, items: [], last_synced: await stampSync(storeId, "depop", { count: 0 }) };
  const unitMap = await unitsBySku(storeId, (rows || []).map((row) => row.sku));
  const items = (rows || [])
    .map((row) => depopRowFromFloor(row, unitMap[row.sku]))
    .filter((row) => listingMatches(row, query));
  const capped = items.slice(0, limit);
  return {
    ok: true,
    channel: "depop",
    items: capped,
    total: items.length,
    live_count: items.length,
    truncated: items.length > capped.length,
    last_synced: await stampSync(storeId, "depop", { count: items.length }),
    stub: false,
    message: "Depop has no listing API. These are the live Floor rows confirmed from Push to Depop.",
  };
}

/**
 * Ready-to-paste Depop listing pack (title, description, fee-aware price, photo download URLs).
 * No marketplace write.
 */
export async function buildDepopPack(storeId, { sku } = {}) {
  const sb = serviceClient();
  const { data: unit, error } = await sb.from("units").select("*").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!unit) return { ok: false, error: "unknown_sku" };
  if (unit.state !== "available" && unit.state !== "reserved") {
    return { ok: false, error: `unit_not_sellable:${unit.state}` };
  }
  const photos = await unitPhotos(storeId, sku);
  if (!photos.paths.length) return { ok: false, error: "photos_required — real unit photos only (no AI)" };

  const floorAsk = Number(unit.ask_cents || 0);
  const label = estimateLabelCost(unit);
  const listCents = calcListPrice(floorAsk, "depop", 0, 0);
  const fee = getFeeConfig().marketplaces.depop;
  const feeCents = Math.round(listCents * fee.rate) + fee.fixedFeeCents;
  const description = composeChannelDescription({
    listingBody: unit.listing_body,
    brand: unit.brand,
    model: unit.model,
    title: unit.title,
    specs: parseListingSpecs(unit.listing_specs),
    defectNotes: unit.defect_notes,
    condition: unit.condition,
    testStatus: unit.test_status,
    sku,
  });

  return {
    ok: true,
    channel: "depop",
    sku,
    pack: {
      title: String(unit.title || `SKU ${sku}`).slice(0, 80),
      description,
      condition: unit.condition,
      brand: unit.brand,
      price_cents: listCents,
      price_display: `$${(listCents / 100).toFixed(2)}`,
      floor_ask_cents: floorAsk,
      fee_cents: feeCents,
      fee_note: `Depop fees ~${(fee.rate * 100).toFixed(1)}% + $${(fee.fixedFeeCents / 100).toFixed(2)} (≈$${(feeCents / 100).toFixed(2)} on this price). List price is Floor ask grossed up for fees.`,
      photos: photos.urls.map((p, i) => ({
        index: i + 1,
        path: p.path,
        download_url: p.url,
      })),
      photo_count: photos.urls.length,
      instructions: [
        "1. Open Depop Seller and create a new listing.",
        "2. Paste title + description; set price to the amount below.",
        "3. Download each photo from Floor (real unit photos only — never AI) and upload in order.",
        "4. Publish on Depop, then paste the listing URL back here (or tap Listed on Depop).",
      ],
      label_estimate: label,
    },
  };
}

/**
 * After you post on Depop: paste URL (preferred) or mark listed without URL.
 * Writes a real listings row + listed_on. Never marks sold.
 */
export async function confirmDepopListed(storeId, { sku, depopUrl = null, markOnly = false } = {}) {
  const sb = serviceClient();
  const { data: unit } = await sb.from("units").select("sku, state, listed_on").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (!unit) return { ok: false, error: "unknown_sku" };
  if (unit.state !== "available" && unit.state !== "reserved") {
    return { ok: false, error: `unit_not_sellable:${unit.state}` };
  }

  let listingId = null;
  let url = null;
  if (!markOnly && depopUrl) {
    const parsed = parseDepopListingRef(depopUrl);
    if (!parsed.ok) return parsed;
    if (parsed.markedOnly) {
      markOnly = true;
    } else {
      listingId = parsed.listingId;
      url = parsed.url;
    }
  }
  if (!markOnly && !listingId) {
    return { ok: false, error: "depop_url_required — paste the Depop product link, or pass mark_only=true" };
  }

  const { error: upErr } = await sb.from("listings").upsert(
    {
      store_id: storeId,
      sku,
      channel: "depop",
      status: "listed",
      listing_id: listingId,
      listed_at: new Date().toISOString(),
      delisted_at: null,
    },
    { onConflict: "store_id,sku,channel" },
  );
  if (upErr) return { ok: false, error: upErr.message };

  const prev = Array.isArray(unit.listed_on) ? unit.listed_on : [];
  const next = [...new Set([...prev.filter((c) => c !== "vendoo" && c !== "mercari"), "depop"])];
  const { error: unitErr } = await sb
    .from("units")
    .update({ listed_on: next, updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", sku);
  if (unitErr) return { ok: false, error: unitErr.message };

  return {
    ok: true,
    channel: "depop",
    sku,
    listing_id: listingId,
    url,
    listed_on: next,
    message: url ? `Depop listing recorded: ${url}` : "Marked listed on Depop (no URL — paste the link later to attach it).",
  };
}

/** Clear Depop listing row + listed_on flag. Does not mark the unit sold. */
export async function endDepopListing(storeId, { sku } = {}) {
  if (!sku) return { ok: false, error: "sku_required" };
  const sb = serviceClient();
  const { data: unit } = await sb.from("units").select("sku, listed_on, state").eq("store_id", storeId).eq("sku", sku).maybeSingle();
  if (!unit) return { ok: false, error: "unknown_sku" };

  await sb
    .from("listings")
    .update({ status: "delisted", delisted_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", sku)
    .eq("channel", "depop")
    .eq("status", "listed");

  const next = (unit.listed_on || []).filter((c) => c !== "depop");
  await sb
    .from("units")
    .update({ listed_on: next, updated_at: new Date().toISOString() })
    .eq("store_id", storeId)
    .eq("sku", sku);

  return { ok: true, ended: true, sku, channel: "depop", unit_state: unit.state, listed_on: next };
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
  if (ch === "ebay" || ch === "depop") {
    const { data } = await sb
      .from("listings")
      .select("sku")
      .eq("store_id", storeId)
      .eq("channel", ch)
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
  if (ch === "depop") {
    const pack = await buildDepopPack(storeId, { sku });
    if (!pack.ok) return pack;
    return {
      ok: true,
      draft: {
        ...base,
        ...pack.pack,
        price_cents: pack.pack.price_cents,
        description: pack.pack.description,
        image_urls: (pack.pack.photos || []).map((p) => p.download_url),
        note: "Depop has no API — copy this pack into Depop Seller, then confirm with the listing URL.",
        mode: "push_pack",
      },
      pack: pack.pack,
    };
  }
  return { ok: false, error: "channel_required" };
}

async function pushReadiness(storeId, unit, channel) {
  const sb = serviceClient();
  const photos = await unitPhotos(storeId, unit.sku);
  let aspectDefs = null;
  let aspects = null;
  let amazonBlocked = null;
  if (channel === "ebay") {
    const { data } = await sb
      .from("ebay_drafts")
      .select("aspect_defs, aspects, category_id")
      .eq("store_id", storeId)
      .eq("sku", unit.sku)
      .maybeSingle();
    aspectDefs = data?.aspect_defs || null;
    aspects = data?.aspects || null;
    if (data?.category_id && !unit.listing_specs?.ebay_category_id && !unit.category && !unit.ebay_category) {
      unit = { ...unit, listing_specs: { ...(unit.listing_specs || {}), ebay_category_id: data.category_id } };
    }
  }
  if (channel === "amazon") {
    const { data } = await sb
      .from("amazon_list_items")
      .select("status, needs_review_reason")
      .eq("store_id", storeId)
      .eq("sku", unit.sku)
      .maybeSingle();
    if (data?.status === "not_on_amazon") amazonBlocked = data.needs_review_reason || "Not on Amazon";
  }
  const local = channelGaps(
    { ...unit, aspects: aspects || unit.aspects },
    { channel, photoCount: photos.paths.length, aspectDefs, amazonBlocked },
  );
  if (!local.ready || channel !== "ebay") return local;
  try {
    const prepared = await prepareUnitAspects({ storeId, unit, liveCheck: false });
    const extra = (prepared.missingRequired || []).filter((name) => !/^(brand|upc|mpn)$/i.test(name));
    if (!extra.length) return local;
    return {
      ready: false,
      gaps: local.gaps,
      summary: extra,
      reason: `Needs: ${extra.slice(0, 3).join(", ")}`,
      section: "missing-category",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/category/i.test(message)) {
      return { ready: false, gaps: local.gaps, summary: ["category"], reason: "Needs: category", section: "missing-category" };
    }
    return { ready: false, gaps: local.gaps, summary: [], reason: message, section: "missing-category" };
  }
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
  if (["ebay", "amazon", "tiktok"].includes(ch)) {
    const ready = await pushReadiness(storeId, unit, ch);
    if (!ready.ready) {
      return { ok: false, error: ready.reason || "listing_not_ready", missing: ready.summary || [], section: ready.section };
    }
  }
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
