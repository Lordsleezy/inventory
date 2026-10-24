import { json, corsHeaders, requireEnv } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { STORE_DEFAULT } from "../lib/amazon.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  const scheduled = isNetlifyScheduleEvent(event);
  const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  const storeId = scheduled ? STORE_DEFAULT : (await portalAdminFromEvent(event, body.store_id || STORE_DEFAULT)).storeId;
  const channel = scheduled ? ["ebay", "tiktok", "amazon"][new Date().getUTCDay() % 3] : String(body.channel || "ebay");
  if (!["ebay", "amazon", "tiktok"].includes(channel)) return json(400, { error: "invalid_channel" });
  const base = (process.env.URL || "https://inventoryobi.netlify.app").replace(/\/$/, "");
  const response = await fetch(`${base}/.netlify/functions/category-sync-background`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, store_id: storeId }),
  });
  return json(response.ok ? 202 : 502, { queued: response.ok, channel, status: response.status });
}

export const invoke = wrapHandler("category-sync", handle);
export default asNetlifyFunction(invoke);
