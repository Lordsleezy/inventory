/** Shippo track_updated webhook → refresh return timelines. */
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { applyShippoTrackWebhook } from "../lib/return-tracking.mjs";
import { applyOrderShippoWebhook } from "../lib/order-tracking.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  let payload = {};
  try { payload = JSON.parse(event.body || "{}"); } catch { payload = {}; }
  const sb = serviceClient();
  const returns = await applyShippoTrackWebhook(sb, payload);
  const orders = await applyOrderShippoWebhook(sb, payload);
  return json(200, { ok: true, returns, orders });
}

export const handler = asNetlifyFunction(handle);
export const invoke = wrapHandler("shippo-tracking-webhook", handle);
