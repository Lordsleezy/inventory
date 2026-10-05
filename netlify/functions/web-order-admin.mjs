/** Floor Admin → Orders actions: buy label, mark shipped, cancel & refund, run pickup sweep. */
import { json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { buyLabelForOrder, labelQuote, voidLabel } from "../lib/web-label.mjs";
import { shippoMode } from "../lib/shippo.mjs";
import { webSquareEnv } from "../lib/web-square.mjs";
import { cancelAndRefund } from "../lib/web-payment.mjs";
import { pickupSweep } from "../lib/web-pickup.mjs";
import { deliverOrderEmails } from "../lib/web-order-email.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  const body = JSON.parse(event.body || "{}");
  let ctx;
  try { ctx = await portalAdminFromEvent(event, body.store_id); }
  catch (err) { return json(err.status || 401, { error: err.message }); }
  const { sb, storeId, actor } = ctx;
  const id = String(body.id || "");
  if (body.action === "label_quote") {
    const r = await labelQuote(sb, storeId, id, body.box);
    return json(r.status, r);
  }
  if (body.action === "buy_label") {
    const r = await buyLabelForOrder(sb, storeId, id, { rateId: String(body.rate_id || ""), box: body.box, actor });
    return json(r.status, r);
  }
  if (body.action === "void_label") {
    const r = await voidLabel(sb, storeId, id);
    return json(r.status, r);
  }
  if (body.action === "shipping_status" || body.action === "set_shipping") {
    const mode = shippoMode();
    const env = webSquareEnv();
    if (body.action === "set_shipping") {
      const enabled = body.enabled === true;
      const { error } = await sb.from("store_settings").upsert({ store_id: storeId, key: "shipping_enabled", value: enabled }, { onConflict: "store_id,key" });
      if (error) return json(500, { error: error.message });
    }
    const { data } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "shipping_enabled").maybeSingle();
    return json(200, { ok: true, enabled: data?.value === true, shippo: mode || "none", mode: mode === "live" ? "live" : "manual", square_env: env });
  }
  if (body.action === "manual_tracking") {
    const carrier = String(body.carrier || "").trim().slice(0, 60);
    const tracking = String(body.tracking || "").trim().slice(0, 100);
    const labelCents = Math.round(Number(body.label_cost_cents));
    if (!carrier || !tracking || !Number.isInteger(labelCents) || labelCents < 0) return json(400, { error: "Enter carrier, tracking number, and a valid label cost." });
    const { data: order, error: loadError } = await sb.from("web_orders").select("*").eq("id", id).eq("store_id", storeId).maybeSingle();
    if (loadError) return json(500, { error: loadError.message });
    if (!order || order.status !== "paid" || order.fulfillment !== "ship" || order.shipped_at) return json(400, { error: "This order is not waiting to ship." });
    const now = new Date().toISOString();
    const trackingUrl = carrier.toLowerCase().includes("usps") ? `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tracking)}`
      : carrier.toLowerCase().includes("ups") ? `https://www.ups.com/track?tracknum=${encodeURIComponent(tracking)}`
        : carrier.toLowerCase().includes("fedex") ? `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}` : null;
    const { data: saved, error: saveError } = await sb.from("web_orders").update({ carrier, tracking_number: tracking, tracking_url: trackingUrl,
      label_cost_cents: labelCents, label_purchased_at: now, shipping_rate: { source: "manual", service: "Purchased externally" }, updated_at: now })
      .eq("id", id).eq("store_id", storeId).select("*").single();
    if (saveError) return json(500, { error: saveError.message });
    const { data: previous } = await sb.from("portal_expenses").select("id,amount_cents").eq("store_id", storeId).eq("order_id", id).eq("source", "manual_label").is("voided_at", null).maybeSingle();
    const { data: owner } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "online_payout_employee_id").maybeSingle();
    const employeeId = typeof owner?.value === "string" ? owner.value : null;
    if (previous) {
      if (previous.amount_cents !== labelCents) await sb.from("portal_expenses").update({ amount_cents: labelCents, description: `Manual shipping label ${order.order_no || id} — ${carrier}`, employee_id: employeeId, needs_reimbursement: Boolean(employeeId) }).eq("id", previous.id);
    } else {
      const { error: expenseError } = await sb.from("portal_expenses").insert({ store_id: storeId, description: `Manual shipping label ${order.order_no || id} — ${carrier}`, category: "Shipping", amount_cents: labelCents,
        needs_reimbursement: Boolean(employeeId), employee_id: employeeId, source: "manual_label", order_id: id });
      if (expenseError) return json(500, { error: `Tracking saved, but label expense failed: ${expenseError.message}` });
    }
    await sb.from("events").insert({ store_id: storeId, sku: order.sku, kind: "edit", field: "manual_shipping_label", new_value: JSON.stringify({ carrier, tracking, label_cost_cents: labelCents }), actor, note: `Order ${order.order_no || id}` });
    const deliveries = await deliverOrderEmails(sb, id).catch(() => []);
    return json(200, { ok: true, order: saved, emailed: deliveries.some(r => r.kind === "tracking" && r.ok) });
  }
  if (body.action === "mark_shipped") {
    const { data, error } = await sb.from("web_orders").update({ shipped_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", id).eq("store_id", storeId).eq("status", "paid").eq("fulfillment", "ship").is("shipped_at", null)
      .is("refund_requested_at", null).not("tracking_number", "is", null).select("*").maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!data) return json(400, { error: "Buy a label (or enter tracking on the phone) before marking shipped." });
    await deliverOrderEmails(sb, id).catch(() => []);
    return json(200, { ok: true, order: data });
  }
  if (body.action === "cancel_refund") {
    const reason = String(body.reason || "").trim() || `Canceled by ${actor}`;
    const r = await cancelAndRefund(sb, storeId, id, "admin", reason);
    return json(r.status, r);
  }
  if (body.action === "pickup_sweep") return json(200, await pickupSweep(sb));
  return json(400, { error: "unknown_action" });
}

export const handler = wrapHandler("web-order-admin", async event => {
  try { return await handle(event); }
  catch (err) {
    if (err.statusCode) return json(502, { error: "Square request failed." });
    return json(500, { error: String(err.message || err).slice(0, 300) });
  }
});
