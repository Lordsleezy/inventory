/**
 * Temporary flat $1.99 on two listings so a three-item cart lands near one box.
 * Nothing here calls eBay. The revert script and the order sync share this.
 */

export const TEMP_FLAT_KEY = "ebay_temp_flat_shipping";
export const TEMP_FLAT_CENTS = 199;
export const TEMP_FLAT_HOURS = 48;
export const TEMP_FLAT_POLICY_NAME = "Floor temp flat $1.99 GA";

export function chooseTempFlat(items) {
  const list = (items || []).filter((item) => item && Number(item.shipping_cents) > 0);
  if (list.length < 2) return { ok: false, reason: "need_two" };
  const ranked = [...list].sort((a, b) =>
    Number(b.shipping_cents) - Number(a.shipping_cents)
    || Number(b.weight_lb) - Number(a.weight_lb)
    || String(a.sku || "").localeCompare(String(b.sku || "")));
  const kept = ranked[0];
  const discount = ranked.slice(1);
  const total = Number(kept.shipping_cents) + discount.length * TEMP_FLAT_CENTS;
  return { ok: true, kept, discount, total_cents: total };
}

export function offerBodyWithPolicy(offer, fulfillmentPolicyId) {
  const body = {
    ...(offer || {}),
    listingPolicies: {
      ...((offer && offer.listingPolicies) || {}),
      fulfillmentPolicyId: String(fulfillmentPolicyId),
    },
  };
  delete body.offerId;
  delete body.listing;
  delete body.status;
  return body;
}

export function flatRatePolicyBody(market = "EBAY_US") {
  return {
    name: TEMP_FLAT_POLICY_NAME,
    marketplaceId: market,
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: false }],
    localPickup: false,
    freightShipping: false,
    pickupDropOff: false,
    globalShipping: false,
    handlingTime: { value: 2, unit: "DAY" },
    shippingOptions: [
      {
        optionType: "DOMESTIC",
        costType: "FLAT_RATE",
        shippingServices: [
          {
            sortOrder: 1,
            shippingCarrierCode: "USPS",
            shippingServiceCode: "USPSParcel",
            shippingCost: { value: "1.99", currency: "USD" },
            freeShipping: false,
            buyerResponsibleForShipping: false,
            buyerResponsibleForPickup: false,
          },
        ],
      },
    ],
  };
}

export function purchasesFromEbayOrders(orders) {
  return (orders || []).map((order) => ({
    order_id: order?.orderId || null,
    buyer: order?.buyer?.username || "",
    canceled: /CANCEL/i.test(String(order?.cancelStatus?.cancelState || "")),
    listing_ids: (order?.lineItems || []).map((line) => String(line?.legacyItemId || "")).filter(Boolean),
  }));
}

function idsOf(hold) {
  return new Set((hold?.items || []).map((item) => String(item.listing_id || "")).filter(Boolean));
}

/**
 * Revert when the named buyer has purchased one of these listings, when anyone
 * buys a listing that is sitting at $1.99, or when the 48-hour window ends.
 * A canceled order does not count. The kept (full-price) listing sold to
 * someone else does not count.
 */
export function shouldRevertTempFlat(hold, { now = Date.now(), orders = [] } = {}) {
  if (!hold?.active) return { revert: false, reason: "not active" };
  const expires = Date.parse(hold.expires_at || "");
  if (Number.isFinite(expires) && now >= expires) return { revert: true, reason: "48 hours passed" };
  const discounted = idsOf(hold);
  const watched = new Set([...discounted, hold.kept?.listing_id].filter(Boolean).map(String));
  const buyer = String(hold.buyer || "").trim().toLowerCase();
  for (const order of orders || []) {
    if (!order || order.canceled) continue;
    const lines = (order.listing_ids || []).map(String);
    const who = String(order.buyer || "").trim().toLowerCase();
    if (lines.some((id) => discounted.has(id))) {
      const why = buyer && who === buyer
        ? `${hold.buyer} bought one`
        : "someone else bought a $1.99 listing";
      return { revert: true, reason: why, order_id: order.order_id || null };
    }
    if (buyer && who === buyer && lines.some((id) => watched.has(id))) {
      return { revert: true, reason: `${hold.buyer} bought one`, order_id: order.order_id || null };
    }
  }
  return { revert: false, reason: "waiting" };
}

function pacific(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(time));
}

export function tempFlatLine(hold) {
  if (!hold || (!hold.active && !hold.reverted_at)) return "";
  const discounted = (hold.items || []).map((item) => `${item.title || "Item"} (SKU ${item.sku})`).join(" and ");
  const kept = hold.kept?.title ? `${hold.kept.title} (SKU ${hold.kept.sku})` : "The other item";
  if (hold.active) {
    const when = pacific(hold.expires_at) || "48 hours";
    return `Temporary $1.99 shipping is on ${discounted} for ${hold.buyer}. ${kept} stays at its normal shipping. Floor puts the $1.99 listings back when ${hold.buyer} buys them, if someone else buys one at $1.99, or at ${when}, whichever comes first.`;
  }
  const when = pacific(hold.reverted_at);
  const why = hold.revert_reason ? ` ${hold.revert_reason}.` : "";
  return `Temporary $1.99 shipping was put back${when ? ` at ${when}` : ""}.${why}`;
}
