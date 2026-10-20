/**
 * Channel-agnostic returns helpers (Amazon MFN report parse, TikTok stub shape,
 * refund-without-return threshold, return-reserve list price bake-in).
 */
import { serviceClient } from "./server.mjs";

export const STORE_DEFAULT = "5487ca47-6147-4fe8-bc6d-46b6472726ba";

export const DEFAULT_RETURN_SETTINGS = {
  reserve_pct: {
    amazon: 10,
    tiktok: 10,
    ebay: 0,
    mercari: 0,
    website: 0,
    depop: 0,
    whatnot: 0,
    facebook: 0,
    other: 0,
  },
  refund_no_return_max_item_cents: 1500,
  refund_no_return_if_label_exceeds_item: true,
  decision_hours: { tiktok: 48, amazon: 72, ebay: 72, default: 72 },
  gate_amazon_tiktok: {
    block_conditions: ["fair", "defective", "for parts", "for_parts"],
    require_real_photos: true,
  },
};

/** Dollars/string → cents. */
export function moneyToCents(raw) {
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 50 && Number.isInteger(raw) ? Math.round(raw) : Math.round(raw * 100);
  }
  const s = String(raw).replace(/[$,\s]/g, "").trim();
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  // Amazon flat file refund amounts are usually dollars with decimals.
  return Math.round(n * 100);
}

export function shouldRefundNoReturn(settings, itemCents, labelCents) {
  const maxItem = Number(settings?.refund_no_return_max_item_cents ?? 1500);
  const labelRule = settings?.refund_no_return_if_label_exceeds_item !== false;
  const item = Math.max(0, Number(itemCents) || 0);
  const label = Math.max(0, Number(labelCents) || 0);
  if (item > 0 && item <= maxItem) return true;
  if (labelRule && label > 0 && item > 0 && label >= item) return true;
  return false;
}

/** Bake return reserve into a candidate list price. Does not mutate ask_cents. */
export function applyReturnReserveCents(listCents, reservePct) {
  const price = Math.max(0, Math.round(Number(listCents) || 0));
  const pct = Number(reservePct) || 0;
  if (price <= 0 || pct <= 0) return price;
  // Integer math avoids float ceil quirks (e.g. 12000 * 1.1 → 13200.0000002).
  return Math.max(price, Math.ceil((price * (100 + pct)) / 100));
}

export function parseAmazonReturnsTsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  if (!raw.trim()) return [];
  const lines = raw.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 2) return [];
  const delim = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(delim).map((h) => h.trim().toLowerCase());
  const idx = (name) => headers.findIndex((h) => h === name || h.replace(/\s+/g, " ") === name);

  const col = {
    orderId: idx("order id"),
    orderDate: idx("order date"),
    returnDate: idx("return request date"),
    status: idx("return request status"),
    rma: idx("amazon rma id"),
    labelCost: idx("label cost"),
    labelPaidBy: idx("label to be paid by"),
    carrier: idx("return carrier"),
    tracking: idx("tracking id"),
    sku: idx("merchant sku"),
    reason: idx("return reason"),
    refund: idx("refunded amount"),
    orderAmount: idx("order amount"),
    resolution: idx("resolution"),
  };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delim);
    const get = (c) => (c >= 0 ? (cells[c] || "").trim() : "");
    const orderId = get(col.orderId);
    const rma = get(col.rma);
    if (!orderId && !rma) continue;
    const statusRaw = get(col.status).toLowerCase();
    let status = "requested";
    if (/approved|authorized/.test(statusRaw)) status = "approved";
    else if (/pending|created|requested/.test(statusRaw)) status = "requested";
    else if (/in.?transit|shipped/.test(statusRaw)) status = "in_transit";
    else if (/received|delivered|completed/.test(statusRaw)) status = "received";
    else if (/closed|resolved/.test(statusRaw)) status = "closed";
    else if (/denied|rejected/.test(statusRaw)) status = "denied";

    const resolution = get(col.resolution).toLowerCase();
    const needsDecision = /pending|awaiting|action.?required|seller/.test(statusRaw + " " + resolution);

    rows.push({
      channel: "amazon",
      external_order_id: orderId,
      external_return_id: rma || `amazon:${orderId}:${get(col.sku) || i}`,
      sku: get(col.sku),
      reason: get(col.reason),
      status,
      needs_decision: needsDecision && status === "requested",
      return_label_cents: moneyToCents(get(col.labelCost)),
      label_paid_by: get(col.labelPaidBy),
      refund_cents: moneyToCents(get(col.refund)),
      order_amount_cents: moneyToCents(get(col.orderAmount)),
      tracking_number: get(col.tracking),
      carrier: get(col.carrier),
      return_request_date: get(col.returnDate),
      order_date: get(col.orderDate),
      resolution: get(col.resolution),
      raw_status: statusRaw,
    });
  }
  return rows;
}

export async function loadReturnSettings(storeId = STORE_DEFAULT) {
  const sb = serviceClient();
  const { data } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "return_settings").maybeSingle();
  return {
    ...DEFAULT_RETURN_SETTINGS,
    ...(data?.value || {}),
    reserve_pct: { ...DEFAULT_RETURN_SETTINGS.reserve_pct, ...(data?.value?.reserve_pct || {}) },
    decision_hours: { ...DEFAULT_RETURN_SETTINGS.decision_hours, ...(data?.value?.decision_hours || {}) },
    gate_amazon_tiktok: {
      ...DEFAULT_RETURN_SETTINGS.gate_amazon_tiktok,
      ...(data?.value?.gate_amazon_tiktok || {}),
    },
  };
}

export async function ingestReturnRow(storeId, payload) {
  const sb = serviceClient();
  const { data, error } = await sb.rpc("ingest_channel_return", {
    p_store: storeId,
    p_channel: payload.channel || "other",
    p_payload: payload,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function reservePctForChannel(storeId, channel) {
  const settings = await loadReturnSettings(storeId);
  const ch = String(channel || "").toLowerCase();
  const pct = settings.reserve_pct?.[ch] ?? settings.reserve_pct?.other ?? 0;
  return Number(pct) || 0;
}
