/**
 * Push tracking + shipped status back to marketplaces after Floor buys a label.
 * Skips when the label source already synced (Veeqo Amazon Buy Shipping, TikTok Create Packages).
 */

import { ebayFetch, resolveEbayAccount, listEbayAccounts } from "../ebay.mjs";
import { spapiFetch } from "../amazon.mjs";
import { tiktokApiFetch } from "../tiktok-shop.mjs";

function carrierCode(carrier) {
  const c = String(carrier || "").toUpperCase();
  if (c.includes("USPS") || c.includes("POSTAL")) return "USPS";
  if (c.includes("UPS")) return "UPS";
  if (c.includes("FEDEX") || c.includes("FED-EX")) return "FedEx";
  if (c.includes("DHL")) return "DHL";
  return String(carrier || "Other").slice(0, 60);
}

async function ebayLineItems(storeId, orderId, accountHint) {
  const order = await ebayFetch(
    storeId,
    "GET",
    `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`,
    undefined,
    accountHint,
  );
  const items = order?.lineItems || order?.lineitems || [];
  return items.map((li) => ({
    lineItemId: li.lineItemId || li.lineItemID,
    quantity: Number(li.quantity || 1),
  })).filter((li) => li.lineItemId);
}

/**
 * eBay: createShippingFulfillment on the account that owns the order.
 */
export async function pushEbayTracking(storeId, order, { trackingNumber, carrier, shippedAt }) {
  const orderId = String(order.order_no || "");
  if (!orderId || !trackingNumber) return { ok: false, error: "missing_order_or_tracking" };

  let accounts = [];
  try {
    accounts = await listEbayAccounts(storeId);
  } catch {
    const one = await resolveEbayAccount(storeId, { role: "selling" }).catch(() => null);
    if (one) accounts = [one];
  }
  // Prefer selling, then others
  accounts = [...accounts].sort((a, b) => {
    const score = (x) => (x.role === "selling" ? 0 : 1);
    return score(a) - score(b);
  });

  let lastErr = null;
  for (const account of accounts) {
    const hint = { _account: account, accountId: account.id };
    try {
      const lineItems = await ebayLineItems(storeId, orderId, hint);
      if (!lineItems.length) {
        lastErr = "ebay_order_no_line_items";
        continue;
      }
      await ebayFetch(
        storeId,
        "POST",
        `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}/shipping_fulfillment`,
        {
          lineItems,
          shippedDate: (shippedAt || new Date()).toISOString(),
          shippingCarrierCode: carrierCode(carrier),
          trackingNumber: String(trackingNumber),
        },
        hint,
      );
      return { ok: true, accountId: account.id, username: account.username };
    } catch (err) {
      lastErr = err.message || String(err);
      // try next account
    }
  }
  return { ok: false, error: lastErr || "ebay_fulfillment_failed" };
}

/**
 * Amazon: confirm shipment via Orders API (SP-API).
 * Veeqo Buy Shipping already syncs — callers should skip when tracking_pushed_by_source.
 */
export async function pushAmazonTracking(storeId, order, { trackingNumber, carrier, shippedAt }) {
  const orderId = String(order.order_no || "");
  if (!orderId || !trackingNumber) return { ok: false, error: "missing_order_or_tracking" };

  // Fetch order items for OrderItemId
  let items = [];
  try {
    const json = await spapiFetch(
      storeId,
      "GET",
      `/orders/v0/orders/${encodeURIComponent(orderId)}/orderItems`,
    );
    items = json?.payload?.OrderItems || json?.OrderItems || [];
  } catch (err) {
    return { ok: false, error: `amazon_order_items: ${err.message}` };
  }
  if (!items.length) return { ok: false, error: "amazon_no_order_items" };

  const body = {
    marketplaceId: process.env.AMAZON_MARKETPLACE_ID || "ATVPDKIKX0DER",
    packageDetail: {
      packageReferenceId: "1",
      carrierCode: carrierCode(carrier),
      carrierName: String(carrier || "").slice(0, 50) || undefined,
      shippingMethod: "Shipment",
      trackingNumber: String(trackingNumber),
      shipDate: (shippedAt || new Date()).toISOString(),
      orderItems: items.map((it) => ({
        orderItemId: it.OrderItemId,
        quantity: Number(it.QuantityOrdered || 1),
      })),
    },
  };

  try {
    // Newer confirmShipment
    await spapiFetch(
      storeId,
      "POST",
      `/orders/v0/orders/${encodeURIComponent(orderId)}/shipmentConfirmation`,
      body,
    );
    return { ok: true };
  } catch (err1) {
    try {
      await spapiFetch(
        storeId,
        "POST",
        `/orders/v0/orders/${encodeURIComponent(orderId)}/shipment`,
        body,
      );
      return { ok: true };
    } catch (err2) {
      return { ok: false, error: err2.message || err1.message };
    }
  }
}

/**
 * TikTok: Update Order Shipping Info for seller-shipped (non-TikTok Shipping) packages.
 * TikTok Shipping Create Packages already marks shipped.
 */
export async function pushTikTokTracking(storeId, order, { trackingNumber, carrier }) {
  const orderId = String(order.order_no || "");
  if (!orderId || !trackingNumber) return { ok: false, error: "missing_order_or_tracking" };
  const body = {
    order_id: orderId,
    tracking_number: String(trackingNumber),
    shipping_provider_id: undefined,
    shipping_provider_name: carrierCode(carrier),
  };
  const paths = [
    "/fulfillment/202309/orders/tracking",
    `/fulfillment/202309/orders/${encodeURIComponent(orderId)}/shipping_info/update`,
  ];
  let lastErr = null;
  for (const path of paths) {
    try {
      const json = await tiktokApiFetch(storeId, "POST", path, body);
      if (json?.code != null && Number(json.code) !== 0) {
        lastErr = json.message || json.msg || `tiktok_code_${json.code}`;
        continue;
      }
      return { ok: true };
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { ok: false, error: lastErr || "tiktok_tracking_push_failed" };
}

export async function pushMarketplaceTracking(storeId, order, shipment, { alreadyPushed = false } = {}) {
  if (alreadyPushed) {
    return { ok: true, skipped: true, reason: "label_source_already_synced_marketplace" };
  }
  const ch = String(order.channel || "website").toLowerCase();
  const args = {
    trackingNumber: shipment.tracking_number,
    carrier: shipment.carrier,
    shippedAt: new Date(),
  };
  if (ch === "ebay") return pushEbayTracking(storeId, order, args);
  if (ch === "amazon") return pushAmazonTracking(storeId, order, args);
  if (ch === "tiktok") return pushTikTokTracking(storeId, order, args);
  return { ok: true, skipped: true, reason: "website_or_unsupported_channel" };
}
