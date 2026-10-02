/** Server-to-server shipping checkout. Square credentials are production-only and independent of register OAuth. */
import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { webSquareConfig } from "../lib/web-square.mjs";
import { settleShippingOrder } from "../lib/web-payment.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  const key = process.env.STORE_WEB_KEY || process.env.STORE_WEB_REWARDS_KEY;
  if (!key || (event.headers?.["x-store-web-key"] || event.headers?.["X-Store-Web-Key"]) !== key) return json(401, { error: "unauthorized" });
  const body = JSON.parse(event.body || "{}");
  const cfg = webSquareConfig(body.store_id);
  const sb = serviceClient();
  if (body.action === "config") return json(200, cfg);
  if (body.action === "begin") {
    for (const name of ["RESEND_API_KEY", "RESEND_FROM", "FLOOR_OWNER_EMAIL"]) {
      if (!process.env[name]) return json(503, { error: `missing_${name}` });
    }
    const buyer = Object.fromEntries(["name", "email", "phone", "line1", "line2", "city", "region", "postal"].map(k => [k, String(body[k] || "").trim()]));
    buyer.country = "US";
    const { data, error } = await sb.rpc("begin_shipping_checkout", {
      p_store: body.store_id, p_sku: String(body.sku || "").trim(), p_buyer: buyer,
      p_redeem_points: Math.max(0, Math.min(2147483647, Math.trunc(Number(body.redeem_points) || 0))),
    });
    if (error) return json(/held_or_unavailable/.test(error.message) ? 409 : 400, { error: error.message });
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
    return json(500, { error: /^missing_|^web_store_not_allowed|^production_square_required/.test(err.message || "") ? err.message : "Checkout unavailable. Retry this order or contact the store." });
  }
});
