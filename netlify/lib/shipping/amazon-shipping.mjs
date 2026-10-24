/**
 * Amazon SP-API Shipping API v2 — direct Buy Shipping fallback when Veeqo is offline.
 * Requires the app role: Direct to Consumer Shipping (Restricted).
 */

import { spapiFetch } from "../amazon.mjs";
import { encodeRateId, LABEL_SOURCES } from "./sources.mjs";

export function amazonShippingConfigured() {
  return Boolean(
    (process.env.AMAZON_LWA_CLIENT_ID || "").trim() &&
      (process.env.AMAZON_LWA_CLIENT_SECRET || "").trim() &&
      ((process.env.AMAZON_REFRESH_TOKEN || "").trim() || process.env.AMAZON_SHIPPING_ENABLED === "1"),
  );
}

export function amazonShippingStatus() {
  if (!amazonShippingConfigured()) {
    return { online: false, reason: "Amazon SP-API credentials incomplete" };
  }
  if (process.env.AMAZON_SHIPPING_ENABLED !== "1") {
    return {
      online: false,
      reason: "Set AMAZON_SHIPPING_ENABLED=1 after Amazon approves Direct to Consumer Shipping (Restricted)",
    };
  }
  return { online: true, reason: null };
}

function shipAddr(a) {
  return {
    name: a.name,
    addressLine1: a.line1 || a.street1,
    addressLine2: a.line2 || a.street2 || undefined,
    stateOrRegion: a.region || a.state,
    city: a.city,
    countryCode: a.country || "US",
    postalCode: a.postal || a.zip,
    email: a.email || undefined,
    phoneNumber: a.phone || undefined,
  };
}

export async function amazonSpapiQuoteRates(storeId, { shipFrom, shipTo, box, orderNo, itemCents } = {}) {
  const st = amazonShippingStatus();
  if (!st.online) return { online: false, rates: [], messages: [st.reason] };
  const body = {
    shipTo: shipAddr(shipTo),
    shipFrom: shipAddr(shipFrom),
    packages: [
      {
        dimensions: {
          length: Number(box.length_in),
          width: Number(box.width_in),
          height: Number(box.height_in),
          unit: "INCH",
        },
        weight: { value: Number(box.weight_lb), unit: "POUND" },
        insuredValue: { value: Math.max(1, Number(itemCents || 100) / 100), unit: "USD" },
        packageClientReferenceId: String(orderNo || "floor").slice(0, 50),
        items: [
          {
            quantity: 1,
            itemValue: { value: Math.max(1, Number(itemCents || 100) / 100), unit: "USD" },
            description: "Merchandise",
            itemIdentifier: String(orderNo || "item").slice(0, 50),
            weight: { value: Number(box.weight_lb), unit: "POUND" },
          },
        ],
      },
    ],
    channelDetails: {
      channelType: "AMAZON",
      amazonOrderDetails: { orderId: String(orderNo) },
    },
  };
  try {
    const json = await spapiFetch(storeId, "POST", "/shipping/v2/shipments/rates", body);
    const payload = json?.payload || json;
    const requestToken = payload?.requestToken || payload?.request_token;
    const rates = [];
    for (const group of payload?.rates || payload?.rateResults || []) {
      const list = group?.rates || (group?.rateId ? [group] : []);
      for (const r of list.length ? list : [group]) {
        const rateId = r.rateId || r.rate_id;
        if (!rateId) continue;
        const total = r.totalCharge?.value ?? r.totalCharge ?? r.price?.value;
        let amountCents = Math.round(Number(total) * 100);
        if (!Number.isFinite(amountCents) || amountCents <= 0) continue;
        rates.push({
          id: encodeRateId(LABEL_SOURCES.amazon, String(rateId)),
          source: LABEL_SOURCES.amazon,
          amount_cents: amountCents,
          carrier: r.carrierName || r.carrierId || "Amazon Shipping",
          service: r.serviceName || r.serviceId || "Buy Shipping",
          days: r.promise?.deliveryWindow?.end ? null : r.deliveryWindowDays ?? null,
          protection: "amazon_buy_shipping",
          raw: { rate_id: String(rateId), request_token: requestToken, order_id: String(orderNo) },
        });
      }
    }
    return {
      online: true,
      rates,
      messages: rates.length ? [] : ["Amazon Shipping v2 returned no rates (role may be missing)"],
    };
  } catch (err) {
    const msg = String(err.message || err);
    const offline =
      /AccessDenied|Unauthorized|403|Unsupported|not authorized|DirectToConsumer/i.test(msg);
    return {
      online: !offline,
      rates: [],
      messages: [
        offline
          ? "Amazon Shipping v2 denied — request Direct to Consumer Shipping (Restricted) on the SP-API app"
          : msg.slice(0, 240),
      ],
    };
  }
}

export async function amazonSpapiBuyLabel(storeId, rate, { labelFormat = "PDF" } = {}) {
  const raw = rate.raw || {};
  if (!raw.rate_id || !raw.request_token) throw new Error("amazon_rate_incomplete — re-quote first");
  const body = {
    requestToken: raw.request_token,
    rateId: raw.rate_id,
    requestedDocumentSpecification: {
      format: labelFormat === "PDF_4x6" ? "PDF" : "PDF",
      size: labelFormat === "PDF_4x6" ? { width: 4, length: 6, unit: "INCH" } : { width: 8.5, length: 11, unit: "INCH" },
      dpi: 300,
      pageLayout: "DEFAULT",
      needFileJoining: false,
      requestedDocumentTypes: ["LABEL"],
    },
  };
  const json = await spapiFetch(storeId, "POST", "/shipping/v2/shipments", body);
  const payload = json?.payload || json;
  const packageDoc = payload?.packageDocumentDetails?.[0] || payload?.packages?.[0];
  const tracking = packageDoc?.trackingId || payload?.trackingId || payload?.trackingNumber;
  const docs = packageDoc?.packageDocuments || [];
  const label = docs.find((d) => /LABEL/i.test(d.type || "")) || docs[0];
  let labelUrl = label?.url || null;
  if (!labelUrl && label?.contents) {
    // Inline base64 — persist via data URL (small labels) or temp storage later
    labelUrl = `data:application/pdf;base64,${label.contents}`;
  }
  if (!tracking) throw new Error("amazon_buy_no_tracking");
  return {
    tracking_number: String(tracking),
    tracking_url: null,
    label_url: labelUrl || "",
    external_shipment_id: String(payload?.shipmentId || raw.rate_id),
    carrier: rate.carrier,
    service: rate.service,
    cost_cents: rate.amount_cents,
    tracking_pushed_by_source: true,
    raw: payload,
  };
}
