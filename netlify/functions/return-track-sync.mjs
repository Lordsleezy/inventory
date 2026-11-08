/** Poll Shippo (or refresh cached events) for a return's inbound tracking. */
import { json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { syncReturnTracking } from "../lib/return-tracking.mjs";
import { registerPendingOrderTracks } from "../lib/order-tracking.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { serviceClient } from "../lib/server.mjs";
import { STORE_DEFAULT } from "../lib/returns.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  const body = JSON.parse(event.body || "{}");
  if (isNetlifyScheduleEvent(event) || body.action === "poll_open") {
    const sb = serviceClient();
    const storeId = body.store_id || STORE_DEFAULT;
    const { data: rows } = await sb.from("returns")
      .select("id")
      .eq("store_id", storeId)
      .not("tracking_number", "is", null)
      .in("status", ["requested", "label_sent", "approved", "in_transit"])
      .limit(40);
    const results = [];
    for (const r of rows || []) {
      results.push(await syncReturnTracking(sb, storeId, r.id));
    }
    const orders = await registerPendingOrderTracks(sb, 20).catch((err) => ({ ok: false, error: err.message }));
    return json(200, { ok: true, polled: results.length, results, order_tracks: orders });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  let ctx;
  try { ctx = await portalAdminFromEvent(event, body.store_id); }
  catch (err) { return json(err.status || 401, { error: err.message }); }
  const returnId = String(body.return_id || "");
  if (!returnId) return json(400, { error: "return_id_required" });
  const result = await syncReturnTracking(ctx.sb, ctx.storeId, returnId);
  return json(200, result);
}

export default asNetlifyFunction(handle);
export const invoke = wrapHandler("return-track-sync", handle);
