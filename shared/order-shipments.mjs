/**
 * Floor Orders lists one card per shipment, not per line.
 * Same buyer + same ship-to (auto within 30 days) or an explicit bundle_link
 * become one shipment. bundle_splits keep a line alone.
 */
import {
  addressKey,
  buyerKey,
  groupOpenOrders,
  quoteBundle,
} from "./bundle-shipping.mjs";

function norm(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function hasLabel(order) {
  return !!(
    order?.label_url
    || order?.label_storage_path
    || order?.label_uploaded_at
    || order?.label_purchased_at
  );
}

/** Lead = earliest paid_at, then sku. */
export function shipmentLead(items) {
  const list = [...(items || [])];
  list.sort((a, b) => {
    const at = Date.parse(a?.paid_at || "") || 0;
    const bt = Date.parse(b?.paid_at || "") || 0;
    if (at !== bt) return at - bt;
    return String(a?.sku || "").localeCompare(String(b?.sku || ""));
  });
  return list[0] || null;
}

export function sameBuyerAndAddress(a, b) {
  if (!a || !b) return { ok: false, reason: "missing_order" };
  const buyerA = buyerKey(a);
  const buyerB = buyerKey(b);
  if (!buyerA || !buyerB) return { ok: false, reason: "missing_buyer" };
  if (buyerA !== buyerB) {
    return {
      ok: false,
      reason: "different_buyer",
      message: `Different buyers (${a.buyer_name || "?"} vs ${b.buyer_name || "?"}). Bundle only works for the same person.`,
    };
  }
  const addrA = addressKey(a);
  const addrB = addressKey(b);
  if (!addrA || !addrB) return { ok: false, reason: "missing_address", message: "Both orders need a full ship-to address." };
  if (addrA !== addrB) {
    return {
      ok: false,
      reason: "different_address",
      message: "Ship-to addresses do not match. Bundle only works when every item goes to the same address.",
    };
  }
  if (norm(a.channel) !== norm(b.channel)) {
    return { ok: false, reason: "different_channel", message: "Those orders are on different channels." };
  }
  return { ok: true };
}

export function canManualBundle(orders) {
  const list = (orders || []).filter(Boolean);
  if (list.length < 2) return { ok: false, reason: "need_two", message: "Select at least two orders." };
  for (const order of list) {
    if (hasLabel(order)) {
      return {
        ok: false,
        reason: "label_exists",
        message: `SKU ${order.sku} already has a label. Void the label first, then bundle.`,
      };
    }
    if (order.shipped_at || order.canceled_at || String(order.status || "").toLowerCase() === "canceled") {
      return { ok: false, reason: "not_open", message: `SKU ${order.sku} is not waiting to ship.` };
    }
  }
  const lead = list[0];
  for (let i = 1; i < list.length; i += 1) {
    const check = sameBuyerAndAddress(lead, list[i]);
    if (!check.ok) return check;
  }
  return { ok: true, lead, items: list };
}

export function canUnbundle(items) {
  const list = items || [];
  if (list.length < 2) return { ok: false, reason: "not_bundled", message: "This is already a single item." };
  const labeled = list.find((order) => hasLabel(order));
  if (labeled) {
    return {
      ok: false,
      reason: "label_exists",
      message: "Unbundle is blocked while a label is on the shipment. Void the label first.",
    };
  }
  return { ok: true };
}

/** Flatten unit package fields so quoteBundle sees length/width/height/weight. */
export function withPackageDims(order) {
  if (!order) return order;
  const pack = order.package || {};
  return {
    ...order,
    length_in: Number(order.length_in ?? pack.length_in) || 0,
    width_in: Number(order.width_in ?? pack.width_in) || 0,
    height_in: Number(order.height_in ?? pack.height_in) || 0,
    weight_lb: Number(order.weight_lb ?? pack.weight_lb) || 0,
  };
}

/**
 * Turn open order rows into shipment cards for Needs label / To ship / Packaged.
 * Singles stay one card; auto and linked groups collapse to one card.
 */
export function listShipments(orders, opts = {}) {
  const open = (orders || []).filter(Boolean).map(withPackageDims);
  const groups = groupOpenOrders(open, opts);
  const covered = new Set();
  const shipments = [];
  for (const group of groups) {
    for (const item of group.items) covered.add(String(item.id));
    const items = [...group.items].sort((a, b) => {
      const at = Date.parse(a?.paid_at || "") || 0;
      const bt = Date.parse(b?.paid_at || "") || 0;
      if (at !== bt) return at - bt;
      return String(a?.sku || "").localeCompare(String(b?.sku || ""));
    });
    const lead = shipmentLead(items);
    const quote = group.quote || quoteBundle(items, opts.rates);
    shipments.push({
      id: group.id,
      bundled: true,
      itemCount: items.length,
      items,
      lead,
      quote,
      package: quote?.package || null,
    });
  }
  for (const order of open) {
    if (covered.has(String(order.id))) continue;
    shipments.push({
      id: String(order.id),
      bundled: false,
      itemCount: 1,
      items: [order],
      lead: order,
      quote: null,
      package: null,
    });
  }
  return shipments;
}

/** Tab header counts: one per shipment card. */
export function countShipments(orders, opts = {}) {
  return listShipments(orders, opts).length;
}

/** Label / tracking / packaged actions use the lead and mirror onto peers. */
export function shipmentPeers(shipment) {
  const leadId = String(shipment?.lead?.id || "");
  return (shipment?.items || []).filter((order) => String(order.id) !== leadId);
}

export function shipmentHasLabel(shipment) {
  return (shipment?.items || []).some((order) => hasLabel(order));
}
