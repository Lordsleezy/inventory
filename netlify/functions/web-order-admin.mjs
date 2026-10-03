/** Floor Admin → Orders actions: buy label, mark shipped, cancel & refund, run pickup sweep. */
import { json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { purchaseLabel } from "../lib/web-label.mjs";
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
  if (body.action === "buy_label") {
    const r = await purchaseLabel(sb, storeId, id);
    return json(r.status, r);
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
