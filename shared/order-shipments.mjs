/**
 * Floor Orders: one row per line until staff taps Bundle.
 * Only explicit bundle_links collapse lines into one shipment card.
 * Same buyer + address is a suggestion, never an automatic merge.
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

function findParent(parent, id) {
  let cursor = id;
  while (parent.get(cursor) !== cursor) cursor = parent.get(cursor);
  return cursor;
}

/** Drop duplicate portal rows that share an id. */
export function dedupeOrders(orders) {
  const seen = new Set();
  const out = [];
  for (const order of orders || []) {
    const id = String(order?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(order);
  }
  return out;
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
  const list = dedupeOrders(orders || []).filter(Boolean);
  if (list.length < 2) return { ok: false, reason: "need_two", message: "Select at least two orders." };
  let clearsLabels = false;
  for (const order of list) {
    if (order.shipped_at || order.packaged_at || order.canceled_at || String(order.status || "").toLowerCase() === "canceled") {
      return { ok: false, reason: "not_open", message: `SKU ${order.sku} is not waiting to ship.` };
    }
    if (hasLabel(order) || order.tracking_number) clearsLabels = true;
  }
  const lead = list[0];
  for (let i = 1; i < list.length; i += 1) {
    const check = sameBuyerAndAddress(lead, list[i]);
    if (!check.ok) return check;
  }
  return {
    ok: true,
    lead,
    items: list,
    clearsLabels,
    message: clearsLabels
      ? "These already have a label or tracking. Bundle will clear them so you can upload one shared label for the box."
      : null,
  };
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

function linkedGroups(open, links, splitIds) {
  const split = new Set((splitIds || []).map(String));
  const usable = open.filter((order) => !split.has(String(order.id)));
  const parent = new Map(usable.map((order) => [String(order.id), String(order.id)]));
  const byId = new Map(usable.map((order) => [String(order.id), order]));
  const union = (a, b) => {
    const left = findParent(parent, String(a));
    const right = findParent(parent, String(b));
    if (left !== right) parent.set(right, left);
  };
  for (const link of links || []) {
    const a = byId.get(String(link.order_id));
    const b = byId.get(String(link.peer_id));
    if (!a || !b) continue;
    if (norm(a.channel) !== norm(b.channel)) continue;
    if (!buyerKey(a) || buyerKey(a) !== buyerKey(b)) continue;
    union(a.id, b.id);
  }
  const grouped = new Map();
  for (const order of usable) {
    const root = findParent(parent, String(order.id));
    const list = grouped.get(root) || [];
    list.push(order);
    grouped.set(root, list);
  }
  return [...grouped.values()].filter((list) => list.length >= 2);
}

function toShipments(groups, open) {
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
    const quote = group.quote || quoteBundle(items);
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

/**
 * Manual links only by default. Unlinked lines stay separate rows even when
 * the buyer and address match. Pass { auto: true } only when a caller wants
 * the old automatic same-buyer grouping.
 */
export function listShipments(orders, opts = {}) {
  const open = dedupeOrders(orders || []).filter(Boolean).map(withPackageDims);
  const groups = opts.auto
    ? groupOpenOrders(open, opts)
    : linkedGroups(open, opts.links || [], opts.splitIds || []).map((items) => ({
      id: items.map((order) => String(order.id)).sort().join(":"),
      items,
      quote: quoteBundle(items, opts.rates),
    }));
  return toShipments(groups, open);
}

/** Tab header counts: one per shipment card (manual bundles + singles). */
export function countShipments(orders, opts = {}) {
  return listShipments(orders, opts).length;
}

/**
 * Same buyer + address clusters that are not yet linked. UI can show
 * "Same buyer: Bundle?" without merging the rows.
 */
export function suggestBundleGroups(orders, opts = {}) {
  const open = dedupeOrders(orders || []).filter(Boolean).map(withPackageDims);
  const linked = new Set();
  for (const ship of listShipments(open, { links: opts.links || [], splitIds: opts.splitIds || [] })) {
    if (!ship.bundled) continue;
    for (const item of ship.items) linked.add(String(item.id));
  }
  const unlinked = open.filter((order) => !linked.has(String(order.id)));
  return groupOpenOrders(unlinked, { splitIds: opts.splitIds || [], rates: opts.rates || [] }).map((group) => ({
    id: group.id,
    buyer: group.buyer,
    itemCount: group.items.length,
    items: group.items,
    ids: group.items.map((order) => String(order.id)),
  }));
}

/** Label / tracking / packaged actions use the lead and mirror onto peers. */
export function shipmentPeers(shipment) {
  const leadId = String(shipment?.lead?.id || "");
  return (shipment?.items || []).filter((order) => String(order.id) !== leadId);
}

export function shipmentHasLabel(shipment) {
  return (shipment?.items || []).some((order) => hasLabel(order));
}
