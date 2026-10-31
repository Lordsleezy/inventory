// Channel quantity follows Floor's available count. Quantity updates must not
// rewrite price, title, photos, or promotions. Debounce is one minute from the
// first change in a burst; later changes in that minute only replace the count.

export const QTY_CHANNELS = ["ebay", "amazon", "tiktok", "website", "depop"];
export const DEBOUNCE_MS = 60_000;

export function positiveQty(value, fallback = 1) {
  const n = Math.trunc(Number(value));
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function orderLineQty(channel, order) {
  const ch = String(channel || "").toLowerCase();
  if (ch === "ebay") {
    const items = order?.lineItems || [];
    const sku = items.find((item) => item?.sku)?.sku;
    const lines = sku ? items.filter((item) => String(item?.sku || "") === String(sku)) : items.slice(0, 1);
    const sum = lines.reduce((n, item) => n + positiveQty(item?.quantity, 0), 0);
    return sum || 1;
  }
  if (ch === "amazon") {
    const item = (order?.OrderItems || order?.orderItems || [])[0] || {};
    return positiveQty(item.QuantityOrdered ?? item.quantity, 1);
  }
  if (ch === "tiktok") {
    const line = order?.line_items?.[0] || order?.item_list?.[0] || order?.order_line_list?.[0] || {};
    return positiveQty(line.quantity ?? line.qty ?? line.sku_count, 1);
  }
  return positiveQty(order?.qty ?? order?.quantity, 1);
}

/** Copy an Inventory API item and change only the available quantity. */
export function ebayInventoryQuantityBody(existing, quantity) {
  const qty = Math.max(0, Math.trunc(Number(quantity) || 0));
  const base = existing && typeof existing === "object" ? structuredClone(existing) : {};
  delete base.sku;
  const ship = base.availability?.shipToLocationAvailability || {};
  const distributions = Array.isArray(ship.availabilityDistributions)
    ? ship.availabilityDistributions.map((row, index) => (index === 0 ? { ...row, quantity: qty } : row))
    : ship.availabilityDistributions;
  return {
    ...base,
    availability: {
      ...(base.availability || {}),
      shipToLocationAvailability: { ...ship, quantity: qty, ...(distributions ? { availabilityDistributions: distributions } : {}) },
    },
  };
}

/** Copy an offer and change only availableQuantity. Price and policies stay. */
export function ebayOfferQuantityBody(existingOffer, quantity) {
  const body = structuredClone(existingOffer || {});
  delete body.offerId;
  delete body.listing;
  delete body.status;
  body.availableQuantity = Math.max(0, Math.trunc(Number(quantity) || 0));
  return body;
}

export function amazonQuantityPatch(quantity) {
  return {
    productType: "PRODUCT",
    patches: [{
      op: "replace",
      path: "/attributes/fulfillment_availability",
      value: [{ fulfillment_channel_code: "DEFAULT", quantity: Math.max(0, Math.trunc(Number(quantity) || 0)) }],
    }],
  };
}

/**
 * What to send for one channel. Null means the listing already shows this count.
 * eBay at 0 is withdraw. Amazon and TikTok get 0. The website hides. Depop is a manual flag.
 */
export function planChannelQuantity({ channel, available, listing }) {
  const qty = Math.max(0, Math.trunc(Number(available) || 0));
  const ch = String(channel || "").toLowerCase();
  const status = String(listing?.status || "").toLowerCase();
  const shown = listing?.quantity == null ? null : Math.max(0, Math.trunc(Number(listing.quantity) || 0));
  if (ch === "depop") {
    if (!listing || status !== "listed") return null;
    if (shown === qty && !listing.stale) return null;
    return { channel: ch, op: "flag", quantity: qty };
  }
  if (qty === 0) {
    if (ch === "ebay") return status === "listed" ? { channel: ch, op: "end", quantity: 0 } : null;
    if (ch === "website") return { channel: ch, op: "hide", quantity: 0 };
    if (shown === 0 && status !== "ended") return null;
    return { channel: ch, op: "set", quantity: 0 };
  }
  if (status === "ended" || status === "delisted" || status === "withdrawn") {
    return { channel: ch, op: "relist", quantity: qty };
  }
  if (ch === "website") return { channel: ch, op: "show", quantity: qty };
  if (shown === qty) return null;
  return { channel: ch, op: "set", quantity: qty };
}

export function debounceQtyRow(existing, quantity, now = new Date()) {
  const qty = Math.max(0, Math.trunc(Number(quantity) || 0));
  const at = now instanceof Date ? now : new Date(now);
  const pending = existing && existing.status === "pending" && new Date(existing.not_before).getTime() > at.getTime();
  return {
    available_qty: qty,
    status: existing?.status === "working" ? "working" : "pending",
    not_before: pending ? existing.not_before : new Date(at.getTime() + DEBOUNCE_MS).toISOString(),
    attempts: pending ? Number(existing.attempts) || 0 : 0,
  };
}

/**
 * In-store and the first paid order win. A later order that does not fit is cancelled.
 * On-hand never goes below zero. Returns the next on-hand and whether the order was kept.
 */
export function takeStock({ onHand, qty, holds = 0 }) {
  const have = Math.max(0, Math.trunc(Number(onHand) || 0));
  const need = positiveQty(qty, 0);
  const reserved = Math.max(0, Math.trunc(Number(holds) || 0));
  const available = Math.max(have - reserved, 0);
  if (need < 1 || available < need || have < need) {
    return { ok: false, onHand: have, reason: "unit_not_sellable" };
  }
  return { ok: true, onHand: have - need };
}
