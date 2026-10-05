/** Server-to-server website checkout: live shipping rates, ship-or-pickup hold, Square payment. */
import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { webSquareConfig, webSquareEnv } from "../lib/web-square.mjs";
import { settleShippingOrder } from "../lib/web-payment.mjs";
import { ownerEmails } from "../lib/web-order-email.mjs";
import { addressTo, allowedCarriers, fallbackRate, liveRates, shippoMode } from "../lib/shippo.mjs";

/** Shipping always has a manual-price fallback; live Shippo rates are preferred when available. */
export const shippingKeyOk = () => true;

const BUYER_FIELDS = ["name", "email", "phone", "line1", "line2", "city", "region", "postal"];
const buyerFrom = body => Object.fromEntries(BUYER_FIELDS.map(k => [k, String(body[k] || "").trim()]));

async function shippingSettings(sb, storeId) {
  const { data } = await sb.from("store_settings").select("key,value").eq("store_id", storeId)
    .in("key", ["ship_max_lb", "ship_tier_5_cents", "ship_tier_15_cents", "ship_tier_30_cents", "manual_shipping_tiers", "manual_oversize_cents"]);
  return Object.fromEntries((data || []).map(r => [r.key, r.value]));
}

export async function quoteRates(sb, storeId, sku, buyer, deps = {}) {
  if (!shippingKeyOk(deps.env ?? webSquareEnv())) return { status: 200, body: { ship: false, pickup: true, reason: "Shipping is not available yet. Choose store pickup." } };
  const { data: unit, error } = await sb.rpc("web_unit_fulfillment", { p_store: storeId, p_sku: sku });
  if (error) throw error;
  if (!unit?.listed) return { status: 409, body: { error: "held_or_unavailable" } };
  if (!unit.ship) return { status: 200, body: { ship: false, reason: unit.reason, pickup: true } };
  if (!buyer.line1 || !buyer.city || !/^[A-Za-z]{2}$/.test(buyer.region) || !/^\d{5}(-?\d{4})?$/.test(buyer.postal)) {
    return { status: 400, body: { error: "Enter a full US shipping address (street, city, 2-letter state, ZIP)." } };
  }
  let rates = [];
  let source = "manual";
  let messages = [];
  if (shippoMode() === "live") {
    try {
      const live = await (deps.liveRates || liveRates)({ shipFrom: unit.ship_from, to: addressTo(buyer), pkg: unit.package, carriers: await allowedCarriers(sb, storeId) });
      rates = live.rates;
      messages = live.messages;
      if (!rates.length && !live.allRates?.length && messages.length) messages = live.messages;
      if (rates.length) source = "shippo";
    } catch {
      rates = [];
    }
  }
  if (!rates.length) {
    // Missing/test/failing Shippo key: current USPS zone-8 tiers, never $0.
    const fb = fallbackRate(await shippingSettings(sb, storeId), unit.package, unit.shipping_cents_override);
    if (!fb) return { status: 200, body: { ship: false, pickup: true, reason: "This package exceeds the manual shipping limits. Choose store pickup or contact us for a shipping quote.", messages } };
    rates = [fb];
    source = "manual";
  }
  const { data: quoteId, error: saveError } = await sb.rpc("save_shipping_quote", {
    p_store: storeId, p_sku: sku, p_postal: buyer.postal, p_region: buyer.region, p_rates: rates, p_source: source,
  });
  if (saveError) throw saveError;
  return { status: 200, body: { ship: true, quote_id: quoteId, source, rates } };
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  const key = process.env.STORE_WEB_KEY || process.env.STORE_WEB_REWARDS_KEY;
  if (!key || (event.headers?.["x-store-web-key"] || event.headers?.["X-Store-Web-Key"]) !== key) return json(401, { error: "unauthorized" });
  const body = JSON.parse(event.body || "{}");
  const sb = serviceClient();
  if (body.action === "config") {
    return json(200, { ...webSquareConfig(body.store_id), shipping: shippoMode() === "live" ? "live" : "manual" });
  }
  if (body.action === "rates") {
    const r = await quoteRates(sb, body.store_id, String(body.sku || "").trim(), buyerFrom(body));
    return json(r.status, r.body);
  }
  if (body.action === "begin") {
    const cfg = webSquareConfig(body.store_id);
    for (const name of ["RESEND_API_KEY", "RESEND_FROM"]) if (!process.env[name]) return json(503, { error: `missing_${name}` });
    if (!(await ownerEmails(sb, body.store_id)).length) return json(503, { error: "missing_owner_emails" });
    const fulfillment = body.fulfillment === "ship" ? "ship" : "pickup";
    const buyer = { ...buyerFrom(body), country: "US" };
    const { data, error } = await sb.rpc("begin_online_checkout", {
      p_store: body.store_id, p_sku: String(body.sku || "").trim(), p_buyer: buyer, p_fulfillment: fulfillment,
      p_quote: fulfillment === "ship" ? body.quote_id || null : null,
      p_rate: fulfillment === "ship" ? String(body.rate_id || "") : null,
      p_redeem_points: Math.max(0, Math.min(2147483647, Math.trunc(Number(body.redeem_points) || 0))),
    });
    if (error) {
      const status = /held_or_unavailable/.test(error.message) ? 409 : 400;
      const friendly = {
        shipping_rate_invalid: "That shipping quote expired. Get shipping rates again.",
        not_shippable: "This item is pickup only.",
        buyer_contact_required: "Name, email, and a 10-digit phone number are required.",
        buyer_address_required: "A full shipping address is required.",
      }[error.message];
      return json(status, { error: friendly || error.message });
    }
    await sb.from("web_orders").update({ payment_env: cfg.env }).eq("id", data.order_id);
    const q = data.quote;
    return json(200, { ...data, ok: true, square: cfg, price_cents: data.item_cents,
      quote: { ...q, subtotal_cents: q.raw_subtotal_cents ?? q.subtotal_cents, discount_cents: Number(q.discount_cents || 0) + Number(q.signup_discount_cents || 0) } });
  }
  if (body.action === "release") {
    const { error } = await sb.rpc("release_shipping_checkout", { p_store: body.store_id, p_reservation: body.reservation_id });
    if (error) return json(409, { error: error.message });
    return json(200, { ok: true });
  }
  if (body.action !== "pay") return json(400, { error: "unknown_action" });
  if (!body.order_id || !body.reservation_id || !body.sku || !body.source_id) return json(400, { error: "order_reservation_sku_source_required" });
  const { data: order, error: prepError } = await sb.rpc("prepare_shipping_payment", {
    p_store: body.store_id, p_order: body.order_id, p_reservation: body.reservation_id, p_sku: body.sku, p_source: body.source_id,
  });
  if (prepError) return json(409, { error: prepError.message });
  return settleShippingOrder(sb, order);
}

export const handler = wrapHandler("web-checkout", async event => {
  try { return await handle(event); }
  catch (err) {
    // Square errors can contain payment tokens; never return the raw SDK exception.
    if (err.statusCode) return json(502, { error: "Square could not complete payment. Retry this order; if it persists, contact the store." });
    return json(500, { error: /^missing_|^web_store_not_allowed|^production_square_required|^sandbox_square_required/.test(err.message || "") ? err.message : "Checkout unavailable. Retry this order or contact the store." });
  }
});
