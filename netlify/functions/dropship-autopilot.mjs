/**
 * Lightweight 15-minute autopilot: tracking pulls + health.
 * Catalog import runs via GitHub Actions (not Netlify) to spare function minutes.
 * Ships no-op when DROPSHIP master switch is off.
 */
import { serviceClient, json } from "../lib/server.mjs";
import { netlifyHandler } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { pullTrackingAndUpload, recomputeHealth } from "../lib/dropship/autopilot.mjs";
import { checkKeepAlive } from "../lib/dropship/alerts.mjs";

async function handle(event) {
  if (!isNetlifyScheduleEvent(event) && event.httpMethod && event.httpMethod !== "POST") {
    return json(405, { error: "method" });
  }
  const sb = serviceClient();
  const { data: stores } = await sb.from("dropship_settings").select("*").eq("enabled", true);
  const results = [];
  for (const settings of stores || []) {
    const storeId = settings.store_id;
    if (settings.paused) {
      results.push({ storeId, skipped: "paused" });
      continue;
    }
    const { data: open } = await sb
      .from("dropship_orders")
      .select("id")
      .eq("store_id", storeId)
      .in("status", ["placed", "tracking"])
      .limit(30);
    for (const o of open || []) {
      try {
        results.push({ storeId, orderId: o.id, ...(await pullTrackingAndUpload(storeId, o.id)) });
      } catch (err) {
        results.push({ storeId, orderId: o.id, error: err.message });
      }
    }
    try {
      await recomputeHealth(storeId);
      await checkKeepAlive(storeId, settings);
    } catch (err) {
      results.push({ storeId, healthError: err.message });
    }
  }
  return json(200, { ok: true, results });
}

export default netlifyHandler("dropship-autopilot", handle);
