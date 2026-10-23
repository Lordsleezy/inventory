/**
 * Veeqo Rate Shopping API — quote/buy without syncing Floor inventory into Veeqo.
 * Auth: VEEQO_API_KEY (x-api-key). Shipping-only; inventory sync must stay OFF in Veeqo UI.
 *
 * Docs: POST /shipping/api/v1/rates , POST /shipping/api/v1/shipments
 */

import { encodeRateId, LABEL_SOURCES } from "./sources.mjs";

const API = "https://api.veeqo.com";

export function veeqoConfigured() {
  return Boolean((process.env.VEEQO_API_KEY || "").trim());
}

export function veeqoStatus() {
  if (!veeqoConfigured()) return { online: false, reason: "VEEQO_API_KEY not set" };
  return { online: true, reason: null };
}

async function veeqoFetch(path, { method = "GET", body, fetchImpl = fetch } = {}) {
  const key = (process.env.VEEQO_API_KEY || "").trim();
  if (!key) {
    const err = new Error("missing_VEEQO_API_KEY");
    err.code = "offline";
    throw err;
  }
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const err = new Error(`veeqo_${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.status = res.status;
    err.detail = data;
    throw err;
  }
  return data;
}

function addr(a) {
  return {
    name: a.name || a.company || "Ship",
    company: a.company || undefined,
    phone: a.phone || undefined,
    email: a.email || undefined,
    line1: a.line1 || a.street1,
    line2: a.line2 || a.street2 || undefined,
    town: a.city || a.town,
    postcode: a.postal || a.zip || a.postcode,
    country_code: a.country || a.country_code || "US",
    county: a.region || a.state || a.county,
  };
}

function normalizeQuotes(payload, { amazonOrder = false } = {}) {
  const list =
    payload?.quotes ||
    payload?.available ||
    payload?.rates ||
    payload?.data?.quotes ||
    payload?.data?.available ||
    [];
  const remoteShipmentId =
    payload?.remote_shipment_id ||
    payload?.remoteShipmentId ||
    payload?.data?.remote_shipment_id ||
    null;
  const out = [];
  for (const q of list) {
    const charge = q.total_net_charge ?? q.totalNetCharge ?? q.amount ?? q.price ?? q.rate;
    // Heuristic: "11.80" / 11.8 → cents; already-integer cents (≥100 with no decimal) kept.
    let amountCents = Number(charge);
    if (!Number.isFinite(amountCents) || amountCents <= 0) continue;
    if (String(charge).includes(".") || amountCents < 100) amountCents = Math.round(amountCents * 100);
    else amountCents = Math.round(amountCents);

    const rateKey = q.name || q.rate_id || q.id || q.service_type;
    if (!rateKey) continue;
    const carrier =
      q.service_carrier ||
      q.sub_carrier_id ||
      q.carrier ||
      q.carrier_name ||
      "Carrier";
    const service = q.service_name || q.display_name || q.service_type || String(rateKey);
    const days =
      q.estimated_days != null
        ? Number(q.estimated_days)
        : q.delivery_days != null
          ? Number(q.delivery_days)
          : q.earliest_delivery_days != null
            ? Number(q.earliest_delivery_days)
            : null;
    out.push({
      id: encodeRateId(LABEL_SOURCES.veeqo, String(rateKey)),
      source: LABEL_SOURCES.veeqo,
      amount_cents: amountCents,
      carrier: String(carrier),
      service: String(service),
      days: Number.isFinite(days) ? days : null,
      protection: amazonOrder ? "amazon_buy_shipping" : null,
      meets_promise: q.meets_delivery_promise === true ? true : undefined,
      raw: {
        rate_id: String(rateKey),
        remote_shipment_id: q.remote_shipment_id || remoteShipmentId,
        shipping_service_options: q.shipping_service_options || q.options || [],
        total_net_charge: q.total_net_charge ?? String(charge),
        base_rate: q.base_rate ?? q.total_net_charge ?? String(charge),
        sub_carrier_id: q.sub_carrier_id,
        service_carrier: q.service_carrier,
        carrier: q.carrier || "amazon_shipping_v2",
      },
    });
  }
  return out.sort((a, b) => a.amount_cents - b.amount_cents);
}

/**
 * Quote via Rate Shopping API (no Veeqo order/allocation required).
 */
export async function veeqoQuoteRates({
  shipFrom,
  shipTo,
  box,
  channel,
  orderNo,
  estimatedValueCents,
  amazonLineItems,
  dueDate,
  sellerName,
  fetchImpl,
} = {}) {
  if (!veeqoConfigured()) {
    return { online: false, rates: [], messages: ["Veeqo offline — set VEEQO_API_KEY"] };
  }
  const amazonOrder = String(channel || "").toLowerCase() === "amazon";
  const body = {
    from_address: addr(shipFrom),
    to_address: addr(shipTo),
    parcels: [
      {
        weight: Number(box.weight_lb),
        weight_unit: "lb",
        length: Number(box.length_in),
        width: Number(box.width_in),
        height: Number(box.height_in),
        dimension_unit: "in",
      },
    ],
    estimated_value: estimatedValueCents != null ? (Number(estimatedValueCents) / 100).toFixed(2) : undefined,
    currency_code: "USD",
    seller_display_name: sellerName || "Open Box Industries",
  };
  if (orderNo) body.customer_reference = String(orderNo);
  if (amazonOrder) {
    body.is_amazon_order = true;
    if (dueDate) body.due_date = dueDate;
    if (Array.isArray(amazonLineItems) && amazonLineItems.length) {
      body.channel_items = amazonLineItems.map((it) => ({
        remote_id: String(it.remote_id || it.order_item_id),
        quantity: Number(it.quantity || 1),
        value: ((Number(it.value_cents || estimatedValueCents || 100) / 100) || 1).toFixed(2),
        currency_code: "USD",
        description: it.description || "Merchandise",
      }));
    }
  }
  try {
    const data = await veeqoFetch("/shipping/api/v1/rates", { method: "POST", body, fetchImpl });
    const rates = normalizeQuotes(data, { amazonOrder });
    return {
      online: true,
      rates,
      messages: rates.length ? [] : ["Veeqo returned no rates (check carriers in Veeqo Shipping settings)"],
      raw: data,
    };
  } catch (err) {
    return { online: false, rates: [], messages: [err.message || "Veeqo quote failed"] };
  }
}

function defaultServiceOptions(options) {
  const out = {};
  for (const opt of options || []) {
    const key = opt.key || opt.name;
    if (!key) continue;
    const values = opt.values || opt.allowed_values || [];
    const first = Array.isArray(values) && values.length ? (values[0]?.value ?? values[0]) : null;
    if (first != null) out[key] = first;
  }
  return out;
}

export async function veeqoBuyLabel(rate, { labelFormat = "PDF", fetchImpl } = {}) {
  if (!veeqoConfigured()) throw new Error("missing_VEEQO_API_KEY");
  const raw = rate.raw || {};
  const remoteId = raw.remote_shipment_id;
  const rateId = raw.rate_id;
  if (!remoteId || !rateId) throw new Error("veeqo_rate_missing_ids — re-quote before buying");
  const opts = defaultServiceOptions(raw.shipping_service_options);
  const body = {
    label_format: labelFormat === "PDF_4x6" || labelFormat === "PDF" ? "PDF" : String(labelFormat || "PDF"),
    shipments: [
      {
        remote_shipment_id: remoteId,
        rate_id: rateId,
        ...opts,
      },
    ],
  };
  const data = await veeqoFetch("/shipping/api/v1/shipments", { method: "POST", body, fetchImpl });
  const shipment =
    data?.shipments?.[0] ||
    data?.data?.shipments?.[0] ||
    data?.shipment ||
    data?.data ||
    data;
  const tracking =
    shipment?.tracking_number ||
    shipment?.trackingNumber ||
    shipment?.packages?.[0]?.tracking_number ||
    null;
  const labelUrl =
    shipment?.label_url ||
    shipment?.labelUrl ||
    shipment?.label?.url ||
    shipment?.packages?.[0]?.label_url ||
    null;
  const shipmentId =
    shipment?.id ||
    shipment?.shipment_id ||
    shipment?.remote_shipment_id ||
    remoteId;
  if (!tracking || !labelUrl) {
    const err = new Error(`veeqo_buy_incomplete: ${JSON.stringify(data).slice(0, 400)}`);
    err.detail = data;
    throw err;
  }
  return {
    tracking_number: String(tracking),
    tracking_url: shipment?.tracking_url || shipment?.trackingUrl || null,
    label_url: String(labelUrl),
    external_shipment_id: String(shipmentId),
    carrier: rate.carrier,
    service: rate.service,
    cost_cents: rate.amount_cents,
    // Amazon Rate Shopping books sync tracking to Seller Central automatically.
    tracking_pushed_by_source: String(rate.protection) === "amazon_buy_shipping",
    raw: data,
  };
}

export async function veeqoVoidLabel(externalShipmentId, { fetchImpl } = {}) {
  if (!veeqoConfigured()) throw new Error("missing_VEEQO_API_KEY");
  const id = encodeURIComponent(String(externalShipmentId));
  // Rate Shopping cancel — path may vary by account; try common endpoints.
  try {
    return await veeqoFetch(`/shipping/api/v1/shipments/${id}/cancel`, { method: "POST", body: {}, fetchImpl });
  } catch (err) {
    if (err.status === 404) {
      return await veeqoFetch(`/shipping/shipments/${id}/cancel`, { method: "POST", body: {}, fetchImpl });
    }
    throw err;
  }
}
