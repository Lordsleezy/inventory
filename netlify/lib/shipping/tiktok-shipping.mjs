/**
 * TikTok Shipping labels (US). USPS for TikTok orders must go through TikTok — not Shippo/Veeqo.
 *
 * Flow: Get Eligible Shipping Service → Create Packages → Get Shipping Document
 * Uses existing tiktokApiFetch + shop_cipher when available.
 */

import { tiktokApiFetch, tiktokAppCredsPresent, shopId } from "../tiktok-shop.mjs";
import { encodeRateId, LABEL_SOURCES, isUspsCarrier } from "./sources.mjs";

export function tiktokShippingConfigured() {
  return tiktokAppCredsPresent() && Boolean(shopId() || process.env.TIKTOK_SHOP_SHOP_CIPHER);
}

export function tiktokShippingStatus() {
  if (!tiktokAppCredsPresent()) return { online: false, reason: "TikTok app keys not set" };
  if (!shopId() && !process.env.TIKTOK_SHOP_SHOP_CIPHER) {
    return { online: false, reason: "TIKTOK_SHOP_SHOP_ID / shop_cipher missing" };
  }
  return { online: true, reason: null };
}

async function shopCipher(storeId) {
  const env = (process.env.TIKTOK_SHOP_SHOP_CIPHER || "").trim();
  if (env) return env;
  // Fallback: authorized shops
  try {
    const json = await tiktokApiFetch(storeId, "GET", "/authorization/202309/shops", null);
    const shops = json?.data?.shops || json?.data || [];
    const first = Array.isArray(shops) ? shops[0] : null;
    return first?.cipher || first?.shop_cipher || null;
  } catch {
    return null;
  }
}

function cipherParams(cipher) {
  return cipher ? { shop_cipher: cipher } : null;
}

/**
 * Quote TikTok Shipping services (includes USPS / TikTok 4PL). Non-USPS carrier options
 * from TikTok are kept; UPS/FedEx from Veeqo/Shippo are quoted separately.
 */
export async function tiktokQuoteRates(storeId, { orderNo, box, warehouseId } = {}) {
  const st = tiktokShippingStatus();
  if (!st.online) return { online: false, rates: [], messages: [st.reason] };
  const cipher = await shopCipher(storeId);
  if (!cipher && !shopId()) {
    return { online: false, rates: [], messages: ["TikTok shop_cipher unavailable — re-authorize TikTok Shop"] };
  }
  const body = {
    order_id: String(orderNo),
    dimension: {
      length: String(box.length_in),
      width: String(box.width_in),
      height: String(box.height_in),
      unit: "INCH",
    },
    weight: { value: String(box.weight_lb), unit: "POUND" },
  };
  if (warehouseId) body.warehouse_id = String(warehouseId);

  const paths = [
    `/fulfillment/202309/orders/${encodeURIComponent(orderNo)}/shipping_services/query`,
    `/fulfillment/202512/orders/${encodeURIComponent(orderNo)}/shipping_services/query`,
  ];
  let lastErr = null;
  for (const path of paths) {
    try {
      const json = await tiktokApiFetch(storeId, "POST", path, body, cipherParams(cipher));
      if (json?.code != null && Number(json.code) !== 0) {
        lastErr = json.message || json.msg || `tiktok_code_${json.code}`;
        continue;
      }
      const services = json?.data?.shipping_services || json?.data?.shippingServices || [];
      const rates = (services || []).map((s) => {
        const price = s.price ?? s.shipping_fee ?? s.amount ?? s.currency_amount;
        let amountCents = Number(price?.price ?? price?.amount ?? price ?? 0);
        if (amountCents > 0 && amountCents < 100 && String(price?.price ?? price).includes(".")) {
          amountCents = Math.round(amountCents * 100);
        } else if (amountCents > 0 && amountCents < 50) {
          amountCents = Math.round(amountCents * 100);
        } else {
          amountCents = Math.round(amountCents);
        }
        const carrier = s.shipping_provider_name || s.provider || s.carrier || "TikTok Shipping";
        const days =
          s.latest_delivery_days != null
            ? Number(s.latest_delivery_days)
            : s.earliest_delivery_days != null
              ? Number(s.earliest_delivery_days)
              : null;
        return {
          id: encodeRateId(LABEL_SOURCES.tiktok, String(s.id)),
          source: LABEL_SOURCES.tiktok,
          amount_cents: amountCents > 0 ? amountCents : 1, // TikTok may allocate later; still show
          carrier: String(carrier),
          service: String(s.name || s.service_name || "TikTok Shipping"),
          days: Number.isFinite(days) ? days : null,
          protection: isUspsCarrier(carrier) ? "tiktok_shipping" : null,
          raw: {
            shipping_service_id: String(s.id),
            warehouse_id: warehouseId || s.warehouse_id || null,
            is_default: s.is_default === true,
            order_id: String(orderNo),
            cipher,
          },
        };
      });
      return {
        online: true,
        rates,
        messages: rates.length ? [] : ["TikTok returned no eligible shipping services for this box"],
      };
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { online: false, rates: [], messages: [lastErr || "TikTok shipping quote failed"] };
}

export async function tiktokBuyLabel(storeId, rate, { box } = {}) {
  const raw = rate.raw || {};
  const orderId = raw.order_id;
  const serviceId = raw.shipping_service_id;
  if (!orderId || !serviceId) throw new Error("tiktok_rate_incomplete — re-quote first");
  const cipher = raw.cipher || (await shopCipher(storeId));
  const body = {
    ship_type: "1",
    order_id: String(orderId),
    shipping_service_id: String(serviceId),
    dimension: {
      length: String(box.length_in),
      width: String(box.width_in),
      height: String(box.height_in),
      unit: "INCH",
    },
    weight: { value: String(box.weight_lb), unit: "POUND" },
  };
  if (raw.warehouse_id) body.warehouse_id = String(raw.warehouse_id);

  const createPaths = ["/fulfillment/202309/packages", "/fulfillment/202512/packages"];
  let pkg = null;
  let lastErr = null;
  for (const path of createPaths) {
    try {
      const json = await tiktokApiFetch(storeId, "POST", path, body, cipherParams(cipher));
      if (json?.code != null && Number(json.code) !== 0) {
        lastErr = json.message || json.msg || `tiktok_code_${json.code}`;
        continue;
      }
      pkg = json?.data || json;
      break;
    } catch (err) {
      lastErr = err.message;
    }
  }
  if (!pkg) throw new Error(lastErr || "tiktok_create_package_failed");

  const packageId = pkg.package_id || pkg.id || pkg.packages?.[0]?.package_id;
  if (!packageId) throw new Error(`tiktok_no_package_id: ${JSON.stringify(pkg).slice(0, 300)}`);

  // Fetch label document
  const docPaths = [
    `/fulfillment/202309/packages/${encodeURIComponent(packageId)}/shipping_documents`,
    `/fulfillment/202512/packages/${encodeURIComponent(packageId)}/shipping_documents`,
  ];
  let doc = null;
  for (const path of docPaths) {
    try {
      const json = await tiktokApiFetch(
        storeId,
        "GET",
        path,
        null,
        { ...cipherParams(cipher), document_type: "SHIPPING_LABEL" },
      );
      if (json?.code != null && Number(json.code) !== 0) continue;
      doc = json?.data || json;
      break;
    } catch {
      /* try next */
    }
  }

  const tracking =
    doc?.tracking_number ||
    pkg.tracking_number ||
    pkg.packages?.[0]?.tracking_number ||
    null;
  const labelUrl = doc?.doc_url || doc?.document_url || doc?.url || null;
  if (!tracking) throw new Error("tiktok_buy_no_tracking");
  if (!labelUrl) throw new Error("tiktok_buy_no_label_url — package created; open TikTok Seller Center for the PDF");

  return {
    tracking_number: String(tracking),
    tracking_url: null,
    label_url: String(labelUrl),
    external_shipment_id: String(packageId),
    carrier: rate.carrier,
    service: rate.service,
    cost_cents: rate.amount_cents,
    // Create Packages marks the order shipped on TikTok.
    tracking_pushed_by_source: true,
    raw: { package: pkg, document: doc },
  };
}

export async function tiktokVoidLabel(/* storeId, packageId */) {
  // TikTok void/cancel package APIs vary by region; surface a clear message for now.
  return {
    ok: false,
    error: "Void TikTok Shipping labels in Seller Center (API cancel not enabled in Floor yet).",
  };
}
