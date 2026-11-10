/**
 * One-box bundle price for orders that share a buyer and a ship-to address.
 *
 * The dollar table starts from Floor's website weight tiers
 * (store_settings ship_tier_5/15/30_cents: $20 / $32 / $50). Those tiers stop
 * at 30 lb. The 50 lb and 70 lb rows continue the same $18 step that already
 * sits between 15 lb and 30 lb ($32 → $50). Every size class is filled with
 * the same prices; an admin can raise a larger class later. Nothing here adds
 * a packaging allowance — the website tiers and the calculated eBay policy do
 * not add one.
 *
 * The looked-up price is then clamped to [most expensive item's own shipping,
 * sum of the separate shipping charges].
 */

export const USPS_GA_MAX_LB = 70;
export const USPS_GA_MAX_LENGTH_IN = 108;
export const USPS_GA_MAX_LENGTH_PLUS_GIRTH = 130;

const BRACKETS = [
  [5, 2000],
  [15, 3200],
  [30, 5000],
  [50, 6800],
  [70, 8600],
];

const SIZE_CLASSES = ["small", "medium", "large", "oversize"];

export const DEFAULT_RATES = SIZE_CLASSES.flatMap((size_class) =>
  BRACKETS.map(([max_lb, price_cents]) => ({ max_lb, size_class, price_cents })),
);

function cents(value) {
  const n = Math.round(Number(value) || 0);
  return n > 0 ? n : 0;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function norm(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function largestRemainder(total, weights) {
  const n = weights.length;
  const goal = Math.max(0, Math.round(total));
  if (!n || goal === 0) return weights.map(() => 0);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const base = Math.floor(goal / n);
    const out = weights.map(() => base);
    let rem = goal - base * n;
    for (let i = 0; rem > 0; i += 1, rem -= 1) out[i % n] += 1;
    return out;
  }
  const exact = weights.map((w) => (goal * w) / sum);
  const out = exact.map((x) => Math.floor(x));
  let rem = goal - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rem > 0; k += 1, rem -= 1) out[order[k % order.length].i] += 1;
  return out;
}

function fitToCaps(shares, caps, target) {
  const out = shares.map((n, i) => Math.min(Math.max(0, n), caps[i]));
  let extra = shares.reduce((sum, n, i) => sum + Math.max(0, n - caps[i]), 0);
  if (extra > 0) {
    const room = out.map((n, i) => Math.max(0, caps[i] - n));
    const add = largestRemainder(Math.min(extra, room.reduce((a, b) => a + b, 0)), room);
    for (let i = 0; i < out.length; i += 1) out[i] += add[i];
  }
  let sum = out.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (sum < target && guard < 100000) {
    const idx = out.findIndex((n, i) => n < caps[i]);
    if (idx < 0) break;
    out[idx] += 1;
    sum += 1;
    guard += 1;
  }
  while (sum > target && guard < 200000) {
    const idx = out.findIndex((n) => n > 0);
    if (idx < 0) break;
    out[idx] -= 1;
    sum -= 1;
    guard += 1;
  }
  return out;
}

export function packageVolume(item) {
  return Number(item.length_in) * Number(item.width_in) * Number(item.height_in);
}

export function longestSide(item) {
  return Math.max(Number(item.length_in) || 0, Number(item.width_in) || 0, Number(item.height_in) || 0);
}

export function biggestPackage(items) {
  return [...items].sort((a, b) => {
    const volume = packageVolume(b) - packageVolume(a);
    if (volume) return volume;
    return longestSide(b) - longestSide(a);
  })[0] || null;
}

export function sizeClass(longest) {
  const n = Number(longest) || 0;
  if (n <= 12) return "small";
  if (n <= 18) return "medium";
  if (n <= 22) return "large";
  return "oversize";
}

export function lookupRateCents(weightLb, size, rates = DEFAULT_RATES) {
  const poolFor = (klass) =>
    (rates || []).filter((row) => row.size_class === klass).sort((a, b) => Number(a.max_lb) - Number(b.max_lb));
  const pool = poolFor(size);
  const rows = pool.length ? pool : poolFor("small");
  if (!rows.length) return null;
  const hit = rows.find((row) => weightLb <= Number(row.max_lb));
  return cents(hit ? hit.price_cents : rows[rows.length - 1].price_cents);
}

export function sumShipping(items) {
  return (items || []).reduce((n, item) => n + cents(item.shipping_cents), 0);
}

export function quoteBundle(items, rates = DEFAULT_RATES) {
  const list = items || [];
  const separate = sumShipping(list);
  const maxSingle = list.reduce((n, item) => Math.max(n, cents(item.shipping_cents)), 0);
  if (list.length < 2) {
    return { ok: false, reason: "one_item", price_cents: separate, separate_cents: separate, max_single_cents: maxSingle, flag: false };
  }
  const missing = list.some((item) =>
    !positive(item.length_in) || !positive(item.width_in) || !positive(item.height_in) || !positive(item.weight_lb));
  if (missing) {
    return {
      ok: false, reason: "missing_measure", price_cents: separate, separate_cents: separate,
      max_single_cents: maxSingle, flag: true,
    };
  }
  const big = biggestPackage(list);
  const weight = list.reduce((n, item) => n + Number(item.weight_lb), 0);
  const sides = [big.length_in, big.width_in, big.height_in].map(Number).sort((a, b) => b - a);
  const length = sides[0];
  const girth = sides[0] + 2 * (sides[1] + sides[2]);
  const box = {
    length_in: Number(big.length_in),
    width_in: Number(big.width_in),
    height_in: Number(big.height_in),
    weight_lb: Math.round(weight * 100) / 100,
  };
  if (weight > USPS_GA_MAX_LB || length > USPS_GA_MAX_LENGTH_IN || girth > USPS_GA_MAX_LENGTH_PLUS_GIRTH) {
    return {
      ok: false, reason: "usps_limit", price_cents: separate, separate_cents: separate,
      max_single_cents: maxSingle, flag: true, package: box, length_in: length, girth_in: girth,
    };
  }
  const klass = sizeClass(length);
  const tier = lookupRateCents(weight, klass, rates);
  let price = tier == null ? maxSingle : tier;
  price = Math.min(separate, Math.max(maxSingle, price));
  return {
    ok: true,
    reason: "ok",
    price_cents: price,
    separate_cents: separate,
    max_single_cents: maxSingle,
    tier_cents: tier,
    size_class: klass,
    flag: false,
    package: box,
    length_in: length,
    girth_in: girth,
  };
}

/**
 * Split the one-box price across items by weight. No item is assigned more
 * than its own shipping charge, and the shares add up to the clamped bundle
 * price. A later refund is only the drop on that item.
 */
export function allocateBundleShipping(items, bundleCents) {
  const rows = (items || []).map((item, index) => ({
    id: String(item.id ?? index),
    shipping: cents(item.shipping_cents),
    weight: Math.max(0, Number(item.weight_lb) || 0),
  }));
  const sum = rows.reduce((n, row) => n + row.shipping, 0);
  const maxSingle = rows.reduce((n, row) => Math.max(n, row.shipping), 0);
  const target = Math.min(sum, Math.max(maxSingle, Math.round(Number(bundleCents) || 0)));
  const shares = fitToCaps(
    largestRemainder(target, rows.map((row) => row.weight)),
    rows.map((row) => row.shipping),
    target,
  );
  return Object.fromEntries(rows.map((row, index) => [row.id, shares[index]]));
}

export function allocateByWeight(items, totalCents) {
  const rows = items || [];
  const shares = largestRemainder(cents(totalCents), rows.map((item) => Math.max(0, Number(item.weight_lb) || 0)));
  return Object.fromEntries(rows.map((item, index) => [String(item.id ?? index), shares[index]]));
}

export function bundleMoneyPlan(items, quote) {
  const list = items || [];
  const bundle = quote?.ok ? quote.price_cents : sumShipping(list);
  const allocations = quote?.ok
    ? allocateBundleShipping(list, bundle)
    : Object.fromEntries(list.map((item) => [String(item.id), cents(item.shipping_cents)]));
  const refunds = list.map((item) => ({
    id: String(item.id),
    order_no: item.order_no || null,
    refund_cents: Math.max(0, cents(item.shipping_cents) - (allocations[String(item.id)] || 0)),
  }));
  const unpaid = list.every((item) => !item.paid_at && String(item.status || "").toLowerCase() !== "paid");
  const paid = list.every((item) => item.paid_at || String(item.status || "").toLowerCase() === "paid");
  let action = "none";
  if (!quote?.ok) action = "separate";
  else if (unpaid) action = "invoice";
  else if (paid) action = "refund";
  else action = "mixed";
  const refund = refunds.reduce((n, row) => n + row.refund_cents, 0);
  return {
    action,
    bundle_cents: bundle,
    separate_cents: sumShipping(list),
    refund_cents: action === "refund" ? refund : 0,
    invoice_cents: action === "invoice" ? bundle : 0,
    allocations,
    refunds,
  };
}

export function buyerKey(order) {
  return norm(order.buyer_name) || norm(order.buyer_email);
}

export function addressKey(order) {
  const line1 = norm(order.ship_line1);
  const postal = norm(order.ship_postal).replace(/\s/g, "");
  if (!line1 || !postal) return "";
  return [line1, norm(order.ship_line2), norm(order.ship_city), norm(order.ship_region), postal].join("|");
}

function isOpen(order) {
  if (!order || order.shipped_at || order.canceled_at || order.delivered_at) return false;
  if (String(order.fulfillment || "ship") === "pickup") return false;
  if (String(order.status || "").toLowerCase() === "canceled") return false;
  return true;
}

function findParent(parent, id) {
  let cursor = id;
  while (parent.get(cursor) !== cursor) cursor = parent.get(cursor);
  return cursor;
}

export function groupOpenOrders(orders, opts = {}) {
  const split = new Set((opts.splitIds || []).map(String));
  const links = opts.links || [];
  const rates = opts.rates || DEFAULT_RATES;
  const open = (orders || []).filter((order) => isOpen(order) && !split.has(String(order.id)));
  const parent = new Map(open.map((order) => [String(order.id), String(order.id)]));
  const union = (a, b) => {
    const left = findParent(parent, String(a));
    const right = findParent(parent, String(b));
    if (left !== right) parent.set(right, left);
  };
  const buckets = new Map();
  for (const order of open) {
    const buyer = buyerKey(order);
    const address = addressKey(order);
    const channel = norm(order.channel);
    if (!buyer || !address || !channel) continue;
    const key = `${channel}|${buyer}|${address}`;
    const list = buckets.get(key) || [];
    list.push(order);
    buckets.set(key, list);
  }
  for (const list of buckets.values()) {
    for (let i = 1; i < list.length; i += 1) union(list[0].id, list[i].id);
  }
  const byId = new Map(open.map((order) => [String(order.id), order]));
  for (const link of links) {
    const a = byId.get(String(link.order_id));
    const b = byId.get(String(link.peer_id));
    if (!a || !b) continue;
    if (norm(a.channel) !== norm(b.channel)) continue;
    if (!buyerKey(a) || buyerKey(a) !== buyerKey(b)) continue;
    union(a.id, b.id);
  }
  const grouped = new Map();
  for (const order of open) {
    const root = findParent(parent, String(order.id));
    const list = grouped.get(root) || [];
    list.push(order);
    grouped.set(root, list);
  }
  const groups = [];
  for (const list of grouped.values()) {
    if (list.length < 2) continue;
    const quote = quoteBundle(list, rates);
    groups.push({
      id: list.map((order) => String(order.id)).sort().join(":"),
      channel: norm(list[0].channel),
      buyer: list[0].buyer_name || list[0].buyer_email || "",
      items: list,
      quote,
      money: bundleMoneyPlan(list, quote),
    });
  }
  return groups;
}

export function assertBundleConfirm(confirm) {
  if (confirm !== true) {
    const err = new Error("confirm_required");
    err.code = "confirm_required";
    throw err;
  }
}

export function dollars(centsValue) {
  return (Math.max(0, Math.round(Number(centsValue) || 0)) / 100).toFixed(2);
}

export function issueRefundBody(refundCents, comment) {
  return {
    reasonForRefund: "SHIPPING_DISCOUNT",
    comment: String(comment || "Your items are shipping in one box. This refund is the difference in shipping.").slice(0, 1000),
    orderLevelRefundAmount: { currency: "USD", value: dollars(refundCents) },
  };
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function addOrderInnerXml({ lineItems, shippingCents, itemCents = 0, shippingService }) {
  const txs = (lineItems || []).map((line) => {
    const itemId = xmlEscape(line.legacyItemId || line.itemId || "");
    const tx = xmlEscape(line.transactionId || "0");
    return `<Transaction><Item><ItemID>${itemId}</ItemID></Item><TransactionID>${tx}</TransactionID></Transaction>`;
  }).join("");
  const service = xmlEscape(shippingService || "USPSGroundAdvantage");
  const ship = Math.max(0, Math.round(Number(shippingCents) || 0));
  const items = Math.max(0, Math.round(Number(itemCents) || 0));
  return `<Order><CreatingUserRole>Seller</CreatingUserRole><Total currencyID="USD">${dollars(items + ship)}</Total><ShippingDetails><ShippingServiceOptions><ShippingService>${service}</ShippingService><ShippingServiceCost currencyID="USD">${dollars(ship)}</ShippingServiceCost><ShippingServicePriority>1</ShippingServicePriority></ShippingServiceOptions></ShippingDetails><TransactionArray>${txs}</TransactionArray></Order>`;
}

export function sendInvoiceInnerXml(orderId) {
  return `<OrderID>${xmlEscape(orderId)}</OrderID><EmailCopyToSeller>true</EmailCopyToSeller>`;
}

export function calculatedCombinedWeightBody(existingDuration) {
  return {
    calculatedShippingRule: { combinedShippingRuleType: "COMBINED_ITEM_WEIGHT" },
    combinedDuration: existingDuration || "DAYS_30",
  };
}

export function combinedWeightDecision(policy, rules) {
  const options = policy?.shippingOptions || [];
  const types = options.map((option) => String(option.costType || "").toUpperCase());
  if (!types.includes("CALCULATED")) return { write: false, reason: types.length ? "flat" : "unknown" };
  const current = rules?.calculatedShippingRule?.combinedShippingRuleType;
  if (current === "COMBINED_ITEM_WEIGHT") return { write: false, reason: "already_on" };
  return { write: true, reason: "calculated", body: calculatedCombinedWeightBody(rules?.combinedDuration) };
}

export const BUYER_REFUND_NOTE = "Your items are shipping in one box. This refund is the difference between the separate shipping charges and the one-box price.";
