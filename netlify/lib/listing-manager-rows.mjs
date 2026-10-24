/**
 * Pure row shaping for the listing manager.
 * Live marketplace rows win; Floor rows fill anything the live pull did not return.
 */

export const LISTING_MANAGER_LIMIT = 2000;

export function centsFromAmount(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function listingMatches(row, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const blob = [row.sku, row.title, row.account, row.asin, row.item_id, row.product_id, row.listing_id, row.offer_sku]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return blob.includes(q);
}

function priceDrift(channelName, priceCents, askCents) {
  if (priceCents == null || askCents == null) return null;
  if (Math.abs(priceCents - askCents) <= 1) return null;
  return `${channelName} price ≠ Floor ask`;
}

export function ebayRowFromActive(account, row, unit = null) {
  const qtyListed = Number(row.quantity || 0);
  const sold = Number(row.quantitySold || 0);
  const qty = Number.isFinite(qtyListed) ? Math.max(0, qtyListed - (Number.isFinite(sold) ? sold : 0)) : null;
  const price = centsFromAmount(row.currentPrice);
  const sku = String(row.sku || "").trim() || null;
  const ask = unit?.ask_cents ?? null;
  const itemId = row.itemId ? String(row.itemId) : null;
  return {
    channel: "ebay",
    account: account.username || account.role || "eBay",
    account_id: account.id || null,
    account_role: account.role || null,
    sku,
    title: row.title || unit?.title || sku || itemId,
    price_cents: price,
    qty,
    status: row.listingStatus || "Active",
    floor_state: unit?.state || null,
    floor_ask_cents: ask,
    drift: priceDrift("eBay", price, ask),
    url: row.viewItemUrl || (itemId ? `https://www.ebay.com/itm/${itemId}` : null),
    editable: account.role === "selling" && Boolean(sku),
    offer_id: null,
    item_id: itemId,
    api: "trading_active",
    shipping_mode: row.shippingMode || null,
  };
}

export function floorOnlyEbayRow(row, unit, account) {
  const itemId = row.listing_id ? String(row.listing_id) : null;
  return {
    channel: "ebay",
    account: account?.username || "Floor",
    account_id: row.ebay_account_id || account?.id || null,
    account_role: account?.role || null,
    sku: row.sku || null,
    title: unit?.title || row.sku,
    price_cents: unit?.ask_cents ?? null,
    qty: null,
    status: row.status || "listed",
    floor_state: unit?.state || null,
    floor_ask_cents: unit?.ask_cents ?? null,
    drift: "On Floor as listed, not in the live eBay Active list",
    url: itemId ? `https://www.ebay.com/itm/${itemId}` : null,
    editable: false,
    offer_id: null,
    item_id: itemId,
    api: "floor",
  };
}

/** Live ActiveList rows first. Floor `listed` rows are added only when neither SKU nor item id was already seen. */
export function mergeEbayListings(liveRows, floorRows, unitsBySku, accountById = {}) {
  const seenSku = new Set();
  const seenItem = new Set();
  const items = [];
  for (const row of liveRows) {
    if (row.sku) seenSku.add(String(row.sku));
    if (row.item_id) seenItem.add(String(row.item_id));
    items.push(row);
  }
  for (const floor of floorRows || []) {
    if (floor.sku && seenSku.has(String(floor.sku))) continue;
    if (floor.listing_id && seenItem.has(String(floor.listing_id))) continue;
    const account = floor.ebay_account_id ? accountById[floor.ebay_account_id] : null;
    const unit = floor.sku ? unitsBySku[floor.sku] : null;
    items.push(floorOnlyEbayRow(floor, unit, account));
    if (floor.sku) seenSku.add(String(floor.sku));
  }
  return items;
}

export function amazonIsLive(item) {
  const summary = (item?.summaries || [])[0] || {};
  const status = summary.status;
  const list = Array.isArray(status) ? status : status ? [status] : [];
  const names = list.map((s) => String(s).toUpperCase());
  if (!names.length) return true;
  return names.some((s) => s === "BUYABLE" || s === "DISCOVERABLE");
}

export function amazonRowFromSearchItem(item, unit, queue, floor) {
  const summary = (item?.summaries || [])[0] || {};
  const offer = (item?.offers || [])[0] || null;
  const avail = (item?.fulfillmentAvailability || [])[0] || null;
  const sku = item?.sku || queue?.sku || floor?.sku || null;
  const price =
    offer?.price?.amount != null
      ? centsFromAmount(offer.price.amount)
      : queue?.amazon_price_cents ?? unit?.ask_cents ?? null;
  const asin = queue?.asin || summary.asin || floor?.listing_id || null;
  const ask = unit?.ask_cents ?? null;
  const statusList = Array.isArray(summary.status) ? summary.status.join(",") : summary.status || queue?.status || floor?.status || "live";
  return {
    channel: "amazon",
    sku,
    title: summary.itemName || unit?.title || sku,
    asin,
    price_cents: price,
    qty: avail?.quantity ?? queue?.qty_listed ?? null,
    status: statusList,
    floor_state: unit?.state || null,
    floor_ask_cents: ask,
    drift: priceDrift("Amazon", price, ask),
    url: asin ? `https://www.amazon.com/dp/${asin}` : null,
    editable: Boolean(queue?.offer_sku || queue?.listing_sku || sku),
    offer_sku: queue?.offer_sku || queue?.listing_sku || sku,
    api: "spapi",
  };
}

export function amazonRowFromFloor(sku, unit, queue, floor) {
  const price = queue?.amazon_price_cents ?? unit?.ask_cents ?? null;
  const asin = queue?.asin || floor?.listing_id || null;
  return {
    channel: "amazon",
    sku,
    title: unit?.title || sku,
    asin,
    price_cents: price,
    qty: queue?.qty_listed ?? null,
    status: queue?.status || floor?.status || "floor",
    floor_state: unit?.state || null,
    floor_ask_cents: unit?.ask_cents ?? null,
    drift: queue?.status === "not_on_amazon" ? queue.needs_review_reason || "Not on Amazon — sell elsewhere" : priceDrift("Amazon", price, unit?.ask_cents ?? null),
    url: asin ? `https://www.amazon.com/dp/${asin}` : null,
    editable: Boolean(queue?.offer_sku || queue?.listing_sku) && ["live", "listing", "ready"].includes(queue?.status || floor?.status),
    offer_sku: queue?.offer_sku || queue?.listing_sku || sku,
    api: "floor",
  };
}

export function tiktokIsLive(status) {
  const s = String(status || "").toUpperCase();
  if (!s) return true;
  return s === "ACTIVATE" || s === "LIVE" || s === "ACTIVATED";
}

export function tiktokPriceCents(product) {
  const price = product?.skus?.[0]?.price || {};
  const raw = price.sale_price ?? price.tax_exclusive_price ?? price.amount ?? product?.sale_price ?? null;
  return centsFromAmount(raw);
}

export function tiktokRowFromProduct(product, unit) {
  const sku = String(product?.skus?.[0]?.seller_sku || product?.external_sku || product?.seller_sku || "").trim() || null;
  const productId = product?.id || product?.product_id || null;
  const price = tiktokPriceCents(product);
  const ask = unit?.ask_cents ?? null;
  const qty = product?.skus?.[0]?.inventory?.[0]?.quantity ?? product?.quantity ?? null;
  return {
    channel: "tiktok",
    sku,
    title: product?.title || product?.product_name || unit?.title || sku || productId,
    product_id: productId,
    price_cents: price,
    qty,
    status: product?.status || product?.product_status || "ACTIVATE",
    floor_state: unit?.state || null,
    floor_ask_cents: ask,
    drift: priceDrift("TikTok", price, ask),
    url: null,
    editable: Boolean(productId),
    api: "tiktok",
  };
}

export function depopListingUrl(listingId) {
  if (!listingId) return null;
  const raw = String(listingId);
  if (raw.startsWith("http")) return raw;
  return `https://www.depop.com/products/${raw}/`;
}

export function depopRowFromFloor(row, unit) {
  const manual = unit?.listing_specs?.manual_updates?.depop || null;
  return {
    channel: "depop",
    sku: row.sku,
    title: unit?.title || row.sku,
    price_cents: unit?.ask_cents ?? null,
    qty: 1,
    status: row.status || "listed",
    floor_state: unit?.state || null,
    floor_ask_cents: unit?.ask_cents ?? null,
    listing_id: row.listing_id || null,
    url: depopListingUrl(row.listing_id),
    editable: false,
    api: "floor",
    note: "Depop has no listing API — this is the Floor row confirmed from Push to Depop.",
    manual_update: manual?.reason || null,
  };
}
