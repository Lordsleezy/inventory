/**
 * How one eBay order becomes Floor rows.
 * A single line item keeps today's payment id and the whole shipping charge.
 * Two or more line items each get a row, one shared shipment, and a weight share
 * of the shipping the buyer already paid. The shares sum to that charge.
 */
import { allocateByWeight } from "./bundle-shipping.mjs";

function toCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function lineRefunded(line) {
  return Array.isArray(line?.refunds) && line.refunds.length > 0;
}

export function planEbayOrderLines(order, options = {}) {
  const feePct = Number(options.feePct ?? 13.25);
  const perOrder = Math.max(0, Math.round(Number(options.perOrderCents ?? 40) || 0));
  const weights = options.weights || {};
  const orderId = String(order?.orderId || "");
  const source = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const single = source.length <= 1;
  const lines = single ? source.slice(0, 1) : source;
  const shipCents = toCents(order?.pricingSummary?.deliveryCost?.value);
  const drafts = lines.map((line, index) => {
    const lineItemId = String(line?.lineItemId || line?.legacyItemId || index + 1);
    const sku = line?.sku ? String(line.sku) : null;
    const itemCents = toCents(
      line?.lineItemCost?.value ?? (single ? order?.pricingSummary?.priceSubtotal?.value : 0),
    );
    const weight = Number(weights[sku]);
    return {
      lineItemId,
      sku,
      itemCents,
      qty: Math.max(1, Math.round(Number(line?.quantity) || 1)),
      title: line?.title || null,
      legacyItemId: line?.legacyItemId ? String(line.legacyItemId) : null,
      weight_lb: Number.isFinite(weight) && weight > 0 ? weight : 0,
    };
  });
  if (!drafts.length) {
    drafts.push({
      lineItemId: "1",
      sku: null,
      itemCents: toCents(order?.pricingSummary?.priceSubtotal?.value),
      qty: 1,
      title: null,
      legacyItemId: null,
      weight_lb: 0,
    });
  }
  const shares = allocateByWeight(
    drafts.map((row) => ({ id: row.lineItemId, weight_lb: row.weight_lb })),
    shipCents,
  );
  const plans = drafts.map((row, index) => ({
    ...row,
    orderId,
    shipCents: single ? shipCents : shares[row.lineItemId] || 0,
    feeCents: Math.round(row.itemCents * (feePct / 100)) + (index === 0 ? perOrder : 0),
    paymentId: single ? `ebay:${orderId}` : `ebay:${orderId}:${row.lineItemId}`,
  }));
  return { single, orderId, shipCents, plans };
}

/** Rows already in Floor for this eBay order. Missing lines are inserts. Shipping is corrected only when a stored share does not match. */
export function ebayLineRepair(plans, existing) {
  const inserts = [];
  const shipping = [];
  for (const plan of plans || []) {
    const row = (existing || []).find(
      (item) => (plan.sku && item.sku === plan.sku) || item.payment_id === plan.paymentId,
    );
    if (!row) {
      inserts.push(plan);
      continue;
    }
    if (String(row.status || "") === "canceled") continue;
    if (Number(row.shipping_cents) !== plan.shipCents) {
      shipping.push({
        id: row.id || null,
        sku: row.sku || plan.sku,
        payment_id: row.payment_id,
        from_cents: Number(row.shipping_cents) || 0,
        shipping_cents: plan.shipCents,
      });
    }
  }
  return { inserts, shipping };
}

/**
 * A full cancel voids every line. A partial refund voids only the lines eBay
 * names. If eBay does not say which line, nothing is touched.
 */
export function refundScope(order) {
  const payment = String(order?.orderPaymentStatus || "").toUpperCase();
  const cancel = String(order?.cancelStatus?.cancelState || "").toUpperCase();
  if (["CANCELED", "CANCELLED"].includes(cancel) || payment === "FULLY_REFUNDED") {
    return { scope: "order", skus: [] };
  }
  if (payment !== "PARTIALLY_REFUNDED") return { scope: "none", skus: [] };
  const skus = [];
  for (const line of order?.lineItems || []) {
    if (!lineRefunded(line) || !line?.sku) continue;
    const sku = String(line.sku);
    if (!skus.includes(sku)) skus.push(sku);
  }
  return { scope: skus.length ? "lines" : "none", skus };
}

/** One eBay order number is one tracking upload, even when Floor has a row per line. */
export function trackingUploads(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = String(row?.channel || "") === "ebay" && row?.order_no
      ? `ebay:${row.order_no}`
      : `id:${row?.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
