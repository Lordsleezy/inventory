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
      if (enabled && !mode) return json(409, { error: "No Shippo key is saved yet." });
      if (enabled && env === "production" && mode !== "live") return json(409, { error: "Shipping can't be turned on for real orders until the LIVE Shippo key is saved (the key on the server is a test key)." });
      const { error } = await sb.from("store_settings").upsert({ store_id: storeId, key: "shipping_enabled", value: enabled }, { onConflict: "store_id,key" });
      if (error) return json(500, { error: error.message });
    }
    const { data } = await sb.from("store_settings").select("value").eq("store_id", storeId).eq("key", "shipping_enabled").maybeSingle();
    return json(200, { ok: true, enabled: data?.value === true, shippo: mode || "none", square_env: env });
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
