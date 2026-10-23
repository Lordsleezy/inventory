/**
 * Multi-source label quoting for Floor Orders.
 * Collects Shippo + Veeqo + TikTok + Amazon (+ eBay Logistics stub), filters by channel rules,
 * picks cheapest (Amazon preference), exposes offline sources for the UI.
 */

import {
  addressTo,
  allowedCarriers,
  buyLabel as shippoBuy,
  getRate as shippoGetRate,
  liveRates as shippoLiveRates,
  shippoMode,
  shippoPlanNote,
  shippoQuotaOrPaymentError,
} from "../shippo.mjs";
import { ownerEmails } from "../web-order-email.mjs";
import {
  channelAllowsLabels,
  decodeRateId,
  LABEL_SOURCES,
  pickCheapestRate,
  rateForbiddenForChannel,
  sourcesForChannel,
  encodeRateId,
} from "./sources.mjs";
import { veeqoQuoteRates, veeqoBuyLabel, veeqoStatus } from "./veeqo.mjs";
import { tiktokQuoteRates, tiktokBuyLabel, tiktokShippingStatus } from "./tiktok-shipping.mjs";
import { ebayLogisticsQuoteRates, ebayLogisticsStatus } from "./ebay-logistics.mjs";
import { amazonSpapiQuoteRates, amazonSpapiBuyLabel, amazonShippingStatus } from "./amazon-shipping.mjs";

const num = (v) => Number(v);
export const validBox = (b) =>
  b &&
  [b.length_in, b.width_in, b.height_in, b.weight_lb].every((v) => Number.isFinite(num(v)) && num(v) > 0) &&
  num(b.weight_lb) <= 150 &&
  Math.max(num(b.length_in), num(b.width_in), num(b.height_in)) <= 108;

export const cleanBox = (b) => ({
  length_in: num(b.length_in),
  width_in: num(b.width_in),
  height_in: num(b.height_in),
  weight_lb: num(b.weight_lb),
});

export async function loadShipFrom(sb, storeId) {
  const { data: from } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "ship_from").maybeSingle();
  const shipFrom = { ...(from?.value || {}) };
  if (!shipFrom.email) shipFrom.email = (await ownerEmails(sb, storeId))[0] || "";
  // Normalize street1 alias
  if (!shipFrom.street1 && shipFrom.line1) shipFrom.street1 = shipFrom.line1;
  if (!shipFrom.line1 && shipFrom.street1) shipFrom.line1 = shipFrom.street1;
  return shipFrom;
}

export async function labelFormatSetting(sb, storeId) {
  const { data } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "label_format").maybeSingle();
  const v = typeof data?.value === "string" ? data.value : data?.value;
  return v === "PDF" || v === "PDF_LETTER" ? "PDF" : "PDF_4x6";
}

export async function amazonPreferCents(sb, storeId) {
  const { data } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", storeId)
    .eq("key", "label_amazon_prefer_cents")
    .maybeSingle();
  const n = Number(typeof data?.value === "number" ? data.value : data?.value);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

async function shippoSourceQuote({ sb, storeId, order, box, shipFrom, deps }) {
  const mode = deps.mode || shippoMode();
  if (!mode) return { source: LABEL_SOURCES.shippo, online: false, rates: [], messages: ["Shippo offline — SHIPPO_API_KEY missing or invalid"] };
  const real = order.payment_env === "production";
  if (real && mode !== "live") {
    return { source: LABEL_SOURCES.shippo, online: false, rates: [], messages: ["Shippo TEST key cannot quote production orders"] };
  }
  if (!real && mode === "live") {
    return { source: LABEL_SOURCES.shippo, online: false, rates: [], messages: ["Shippo LIVE key skipped for sandbox orders"] };
  }
  try {
    const quote = await (deps.liveRates || shippoLiveRates)({
      shipFrom,
      to: addressTo({
        name: order.buyer_name,
        line1: order.ship_line1,
        line2: order.ship_line2,
        city: order.ship_city,
        region: order.ship_region,
        postal: order.ship_postal,
        phone: order.buyer_phone,
        email: order.buyer_email,
      }),
      pkg: box,
      carriers: await allowedCarriers(sb, storeId),
    });
    const rates = (quote.all || quote.rates || []).map((r) => ({
      ...r,
      id: r.id.startsWith("shippo:") ? r.id : encodeRateId(LABEL_SOURCES.shippo, r.id),
      source: LABEL_SOURCES.shippo,
      raw: { shippo_rate_id: r.id.includes(":") ? decodeRateId(r.id).remoteId : r.id },
    }));
    const messages = [...(quote.messages || [])];
    if (rates.length) messages.push(shippoPlanNote());
    return {
      source: LABEL_SOURCES.shippo,
      online: true,
      rates,
      messages,
    };
  } catch (err) {
    const quota = shippoQuotaOrPaymentError(err);
    return {
      source: LABEL_SOURCES.shippo,
      online: false,
      rates: [],
      messages: [
        quota
          ? `Shippo payment/quota error — skipped; using other sources. ${err.message || ""}`.trim()
          : err.message || "Shippo quote failed",
      ],
    };
  }
}

/**
 * Quote every allowed source for the order's channel in parallel.
 */
export async function multiSourceQuote(sb, storeId, order, box, deps = {}) {
  const channel = String(order.channel || "website").toLowerCase();
  if (!channelAllowsLabels(channel)) {
    return {
      ok: false,
      status: 400,
      error: `One-click labels are not available for ${channel} (Depop and similar stay manual).`,
    };
  }
  if (!validBox(box)) {
    return { ok: false, status: 400, error: "Enter the box length, width, height (in) and weight (lb). Quotes never run on a blank box." };
  }
  const useBox = cleanBox(box);
  const shipFrom = await loadShipFrom(sb, storeId);
  if (!shipFrom.street1 && !shipFrom.line1) {
    return { ok: false, status: 400, error: "Store ship-from address is not set (Settings → shipping)." };
  }

  const wanted = sourcesForChannel(channel);
  const preferCents = await amazonPreferCents(sb, storeId);
  const format = await labelFormatSetting(sb, storeId);

  const tasks = wanted.map(async (source) => {
    if (source === LABEL_SOURCES.shippo) {
      return shippoSourceQuote({ sb, storeId, order, box: useBox, shipFrom, deps });
    }
    if (source === LABEL_SOURCES.veeqo) {
      const st = veeqoStatus();
      if (!st.online) return { source, online: false, rates: [], messages: [st.reason] };
      const r = await veeqoQuoteRates({
        shipFrom: {
          name: shipFrom.name,
          company: shipFrom.company || shipFrom.name,
          phone: shipFrom.phone,
          email: shipFrom.email,
          line1: shipFrom.street1 || shipFrom.line1,
          line2: shipFrom.street2 || shipFrom.line2,
          city: shipFrom.city,
          region: shipFrom.state || shipFrom.region,
          postal: shipFrom.zip || shipFrom.postal,
          country: shipFrom.country || "US",
        },
        shipTo: {
          name: order.buyer_name,
          phone: order.buyer_phone,
          email: order.buyer_email,
          line1: order.ship_line1,
          line2: order.ship_line2,
          city: order.ship_city,
          region: order.ship_region,
          postal: order.ship_postal,
          country: "US",
        },
        box: useBox,
        channel,
        orderNo: order.order_no,
        estimatedValueCents: order.item_cents,
        sellerName: shipFrom.name || "Open Box Industries",
        fetchImpl: deps.fetchImpl,
      });
      return { source, ...r };
    }
    if (source === LABEL_SOURCES.tiktok) {
      const st = tiktokShippingStatus();
      if (!st.online) return { source, online: false, rates: [], messages: [st.reason] };
      const r = await tiktokQuoteRates(storeId, { orderNo: order.order_no, box: useBox });
      return { source, ...r };
    }
    if (source === LABEL_SOURCES.amazon) {
      const st = amazonShippingStatus();
      if (!st.online) return { source, online: false, rates: [], messages: [st.reason] };
      const r = await amazonSpapiQuoteRates(storeId, {
        shipFrom: {
          name: shipFrom.name,
          line1: shipFrom.street1 || shipFrom.line1,
          line2: shipFrom.street2,
          city: shipFrom.city,
          region: shipFrom.state,
          postal: shipFrom.zip,
          phone: shipFrom.phone,
          email: shipFrom.email,
          country: "US",
        },
        shipTo: {
          name: order.buyer_name,
          line1: order.ship_line1,
          line2: order.ship_line2,
          city: order.ship_city,
          region: order.ship_region,
          postal: order.ship_postal,
          phone: order.buyer_phone,
          email: order.buyer_email,
          country: "US",
        },
        box: useBox,
        orderNo: order.order_no,
        itemCents: order.item_cents,
      });
      return { source, ...r };
    }
    if (source === LABEL_SOURCES.ebay_logistics) {
      const st = ebayLogisticsStatus();
      const r = await ebayLogisticsQuoteRates();
      return { source, online: st.online, rates: r.rates, messages: r.messages || [st.reason] };
    }
    return { source, online: false, rates: [], messages: ["unknown_source"] };
  });

  const settled = await Promise.all(tasks);
  const sources = settled.map((s) => ({
    source: s.source,
    online: Boolean(s.online),
    rate_count: (s.rates || []).length,
    messages: s.messages || [],
  }));

  let rates = settled.flatMap((s) => s.rates || []);
  rates = rates.filter((r) => !rateForbiddenForChannel(channel, r));
  rates.sort((a, b) => a.amount_cents - b.amount_cents || (a.days ?? 99) - (b.days ?? 99));

  const pick = pickCheapestRate(rates, { channel, preferAmazonWithinCents: preferCents });
  if (!pick) {
    const offlineNotes = sources.filter((s) => !s.online).map((s) => `${s.source}: ${(s.messages || []).join("; ")}`);
    return {
      ok: false,
      status: 502,
      error: `No valid rates. ${offlineNotes.join(" · ") || "All sources returned empty."}`,
      sources,
      rates: [],
      box: useBox,
      label_format: format,
    };
  }

  return {
    ok: true,
    status: 200,
    box: useBox,
    rates,
    selected_id: pick.rate.id,
    selected_reason: pick.reason,
    sources,
    label_format: format,
    messages: settled.flatMap((s) => s.messages || []).slice(0, 12),
  };
}

export async function buyFromRate(sb, storeId, order, rateId, box, { labelFormat, deps = {} } = {}) {
  const { source, remoteId } = decodeRateId(rateId);
  const useBox = cleanBox(box);
  const format = labelFormat || (await labelFormatSetting(sb, storeId));

  if (source === LABEL_SOURCES.shippo || (!source && remoteId)) {
    const shippoRateId = source === LABEL_SOURCES.shippo ? remoteId : rateId;
    const rate = await (deps.getRate || shippoGetRate)(shippoRateId);
    const fileType = format === "PDF" ? "PDF" : "PDF_4x6";
    const tx = await (deps.buyLabel || shippoBuy)(shippoRateId, {
      metadata: `OBI ${order.channel || "web"} ${order.order_no} SKU ${order.sku}`,
      labelFileType: fileType,
    });
    if (tx.status !== "SUCCESS" || !tx.tracking_number) {
      const msg = (tx.messages || []).map((m) => m.text || String(m)).join("; ");
      {
        const err = Object.assign(new Error(`Shippo label failed${msg ? `: ${msg}` : ""}`), {
          status: 502,
          detail: tx,
        });
        if (shippoQuotaOrPaymentError(err)) {
          err.message = `${err.message}. Re-quote — Floor will skip Shippo and prefer Veeqo/other sources.`;
        }
        throw err;
      }
    }
    return {
      source: LABEL_SOURCES.shippo,
      tracking_number: tx.tracking_number,
      tracking_url: tx.tracking_url_provider || null,
      label_url: tx.label_url,
      external_shipment_id: tx.object_id,
      transaction_id: tx.object_id,
      rate_id: shippoRateId,
      carrier: rate.carrier,
      service: rate.service,
      estimated_days: rate.days,
      cost_cents: rate.amount_cents,
      tracking_pushed_by_source: false,
      label_format: fileType,
      quote_snapshot: rate,
    };
  }

  // For multi-source rates we need the full rate object (raw). Callers pass selectedRate.
  throw new Error("buyFromRate_requires_selected_rate_object");
}

export async function buySelectedRate(storeId, order, selectedRate, box, { labelFormat, deps = {} } = {}) {
  const format = labelFormat || "PDF_4x6";
  const useBox = cleanBox(box);
  const source = selectedRate.source;

  if (source === LABEL_SOURCES.shippo) {
    const shippoRateId = selectedRate.raw?.shippo_rate_id || decodeRateId(selectedRate.id).remoteId;
    const rate = await (deps.getRate || shippoGetRate)(shippoRateId);
    const fileType = format === "PDF" ? "PDF" : "PDF_4x6";
    // Patch shippo buy to accept file type
    const tx = await (deps.buyLabel || ((id, opts) => shippoBuy(id, opts)))(shippoRateId, {
      metadata: `OBI ${order.channel || "web"} ${order.order_no} SKU ${order.sku}`,
      labelFileType: fileType,
    });
    if (tx.status !== "SUCCESS" || !tx.tracking_number) {
      const msg = (tx.messages || []).map((m) => m.text || String(m)).join("; ");
      {
        const err = Object.assign(new Error(`Shippo label failed${msg ? `: ${msg}` : ""}`), {
          status: 502,
          detail: tx,
        });
        if (shippoQuotaOrPaymentError(err)) {
          err.message = `${err.message}. Re-quote — Floor will skip Shippo and prefer Veeqo/other sources.`;
        }
        throw err;
      }
    }
    return {
      source,
      tracking_number: tx.tracking_number,
      tracking_url: tx.tracking_url_provider || null,
      label_url: tx.label_url,
      external_shipment_id: tx.object_id,
      transaction_id: tx.object_id,
      rate_id: shippoRateId,
      carrier: rate.carrier,
      service: rate.service,
      estimated_days: rate.days,
      cost_cents: rate.amount_cents,
      tracking_pushed_by_source: false,
      label_format: fileType,
      quote_snapshot: selectedRate,
    };
  }

  if (source === LABEL_SOURCES.veeqo) {
    const bought = await veeqoBuyLabel(selectedRate, { labelFormat: format === "PDF_4x6" ? "PDF" : format, fetchImpl: deps.fetchImpl });
    return {
      source,
      tracking_number: bought.tracking_number,
      tracking_url: bought.tracking_url,
      label_url: bought.label_url,
      external_shipment_id: bought.external_shipment_id,
      transaction_id: bought.external_shipment_id,
      rate_id: selectedRate.id,
      carrier: bought.carrier,
      service: bought.service,
      estimated_days: selectedRate.days,
      cost_cents: bought.cost_cents,
      tracking_pushed_by_source: Boolean(bought.tracking_pushed_by_source),
      label_format: format,
      quote_snapshot: selectedRate,
    };
  }

  if (source === LABEL_SOURCES.tiktok) {
    const bought = await tiktokBuyLabel(storeId, selectedRate, { box: useBox });
    return {
      source,
      tracking_number: bought.tracking_number,
      tracking_url: bought.tracking_url,
      label_url: bought.label_url,
      external_shipment_id: bought.external_shipment_id,
      transaction_id: bought.external_shipment_id,
      rate_id: selectedRate.id,
      carrier: bought.carrier,
      service: bought.service,
      estimated_days: selectedRate.days,
      cost_cents: bought.cost_cents,
      tracking_pushed_by_source: Boolean(bought.tracking_pushed_by_source),
      label_format: format,
      quote_snapshot: selectedRate,
    };
  }

  if (source === LABEL_SOURCES.amazon) {
    const bought = await amazonSpapiBuyLabel(storeId, selectedRate, { labelFormat: format });
    return {
      source,
      tracking_number: bought.tracking_number,
      tracking_url: bought.tracking_url,
      label_url: bought.label_url,
      external_shipment_id: bought.external_shipment_id,
      transaction_id: bought.external_shipment_id,
      rate_id: selectedRate.id,
      carrier: bought.carrier,
      service: bought.service,
      estimated_days: selectedRate.days,
      cost_cents: bought.cost_cents,
      tracking_pushed_by_source: Boolean(bought.tracking_pushed_by_source),
      label_format: format,
      quote_snapshot: selectedRate,
    };
  }

  throw new Error(`unsupported_label_source:${source}`);
}
