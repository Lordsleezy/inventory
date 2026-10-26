// Pure helpers: read "shipped" from eBay so Floor orders leave To ship on their own.
// eBay's Fulfillment API lists a shipping_fulfillment href on an order once a label/tracking exists
// (orderFulfillmentStatus FULFILLED, or IN_PROGRESS for a partly shipped order).

/** Orders that eBay says have a shipment and are not canceled/refunded. */
export function ordersWithShipment(orders) {
  return (orders || []).filter((o) => {
    if (!o?.orderId) return false;
    if (!Array.isArray(o.fulfillmentHrefs) || o.fulfillmentHrefs.length === 0) return false;
    if (/CANCELED|CANCELLED/i.test(String(o?.cancelStatus?.cancelState || ""))) return false;
    if (/FULLY_REFUNDED/i.test(String(o?.orderPaymentStatus || ""))) return false;
    return true;
  });
}

/** Path (and query) of the first shipping_fulfillment href, relative to the eBay API host. */
export function fulfillmentPath(order) {
  const href = order?.fulfillmentHrefs?.[0];
  if (!href) return null;
  try {
    const u = new URL(href);
    return `${u.pathname}${u.search}`;
  } catch {
    return String(href).startsWith("/") ? String(href) : null;
  }
}

/** web_orders columns to set from an eBay shipping_fulfillment; null when eBay has no usable shipment. */
export function shipmentPatch(fulfillment, nowIso) {
  if (!fulfillment || typeof fulfillment !== "object") return null;
  const shipped = Date.parse(fulfillment.shippedDate || "");
  const patch = { shipped_at: Number.isFinite(shipped) ? new Date(shipped).toISOString() : nowIso };
  const tracking = String(fulfillment.shipmentTrackingNumber || "").trim();
  if (tracking) patch.tracking_number = tracking.slice(0, 80);
  const carrier = String(fulfillment.shippingCarrierCode || "").trim();
  if (carrier) patch.carrier = carrier.slice(0, 80);
  return patch;
}
