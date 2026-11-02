// Pure helpers for eBay fulfillment polling and label sync.
// eBay adds a shipping_fulfillment href once a label/tracking exists; Floor still moves to Shipped only when staff marks it.

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

/** Tracking/carrier only — does not set shipped_at (staff mark shipped on Orders). */
export function trackingPatch(fulfillment) {
  if (!fulfillment || typeof fulfillment !== "object") return null;
  const patch = {};
  const tracking = String(fulfillment.shipmentTrackingNumber || "").trim();
  if (tracking) patch.tracking_number = tracking.slice(0, 80);
  const carrier = String(fulfillment.shippingCarrierCode || "").trim();
  if (carrier) patch.carrier = carrier.slice(0, 80);
  return Object.keys(patch).length ? patch : null;
}

/** Legacy: includes shipped_at. Not used for eBay order poll sync. */
export function shipmentPatch(fulfillment, nowIso) {
  const tracking = trackingPatch(fulfillment);
  if (!tracking) {
    if (!fulfillment || typeof fulfillment !== "object") return null;
    const shipped = Date.parse(fulfillment.shippedDate || "");
    return { shipped_at: Number.isFinite(shipped) ? new Date(shipped).toISOString() : nowIso };
  }
  const shipped = Date.parse(fulfillment.shippedDate || "");
  return {
    ...tracking,
    shipped_at: Number.isFinite(shipped) ? new Date(shipped).toISOString() : nowIso,
  };
}
