import { addressTo, buyLabel, liveRates } from "./shippo.mjs";
import { deliverOrderEmails, ownerEmails } from "./web-order-email.mjs";

/**
 * One-click label: buy the rate the customer paid for; if it expired (or checkout used the
 * fallback tier) re-quote and buy the same carrier service, else the cheapest. Saving the tracking
 * number queues the tracking email.
 */
export async function purchaseLabel(sb, storeId, orderId, deps = {}) {
  const { data: order, error } = await sb.from("web_orders").select("*").eq("id", orderId).eq("store_id", storeId).maybeSingle();
  if (error) throw error;
  if (!order || order.fulfillment !== "ship" || order.status !== "paid") return { ok: false, status: 400, error: "Not a paid shipping order." };
  if (order.refund_requested_at) return { ok: false, status: 409, error: "Order is being canceled." };
  if (order.label_url && order.tracking_number) return { ok: true, status: 200, order, reused: true };

  const buy = deps.buyLabel || buyLabel;
  let tx = null;
  let rate = order.shipping_rate?.source === "shippo" ? order.shipping_rate : null;
  const attempts = [];
  if (rate) {
    tx = await buy(rate.id).catch(e => ({ status: "ERROR", messages: [{ text: e.message }] }));
    attempts.push(tx.status);
  }
  if (!tx || tx.status !== "SUCCESS") {
    // The unit is sold (off the storefront) by now, so read package + origin directly.
    const { data: from } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "ship_from").single();
    const shipFrom = { ...(from?.value || {}) };
    if (!shipFrom.email) shipFrom.email = (await ownerEmails(sb, storeId))[0] || "";
    const { data: u } = await sb.from("units").select("package_length_in,package_width_in,package_height_in,package_weight_lb").eq("store_id", storeId).eq("sku", order.sku).single();
    const pkg = { length_in: u.package_length_in, width_in: u.package_width_in, height_in: u.package_height_in, weight_lb: u.package_weight_lb };
    if (!(pkg.length_in && pkg.width_in && pkg.height_in && pkg.weight_lb)) return { ok: false, status: 400, error: "Unit is missing package dimensions/weight." };
    const quote = await (deps.liveRates || liveRates)({
      shipFrom,
      to: addressTo({ name: order.buyer_name, line1: order.ship_line1, line2: order.ship_line2, city: order.ship_city, region: order.ship_region, postal: order.ship_postal, phone: order.buyer_phone, email: order.buyer_email }),
      pkg,
    });
    const all = quote.rates;
    rate = all.find(r => order.shipping_rate?.token && r.token === order.shipping_rate.token && r.carrier === order.shipping_rate.carrier) || all[0];
    if (!rate) return { ok: false, status: 502, error: `No carrier rates: ${quote.messages.join("; ") || "unknown"}` };
    tx = await buy(rate.id);
    attempts.push(tx.status);
  }
  if (tx.status !== "SUCCESS" || !tx.tracking_number) {
    const msg = (tx.messages || []).map(m => m.text || String(m)).join("; ");
    return { ok: false, status: 502, error: `Label purchase failed${msg ? `: ${msg}` : ""}`, attempts };
  }
  const now = new Date().toISOString();
  const { data: saved, error: saveError } = await sb.from("web_orders").update({
    tracking_number: tx.tracking_number, tracking_url: tx.tracking_url_provider || null,
    label_url: tx.label_url, label_transaction_id: tx.object_id,
    label_cost_cents: rate.amount_cents, carrier: rate.carrier, service: rate.service,
    label_purchased_at: now, boxed_at: order.boxed_at || now, updated_at: now,
  }).eq("id", order.id).is("tracking_number", null).select("*").maybeSingle();
  if (saveError) throw saveError;
  await (deps.deliver || deliverOrderEmails)(sb, order.id).catch(() => []);
  return { ok: true, status: 200, order: saved, attempts };
}
