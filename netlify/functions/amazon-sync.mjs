/**
 * Amazon order sync (scheduled).
 * Schedule body `{ next_run }` → poll orders / finances / zero qty for sold-elsewhere units.
 */
import { json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { amazonConnectionStatus, runAmazonSyncJob } from "../lib/amazon.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };

  // Manual health check (no secrets): connection status only.
  try {
    const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
    if (body?.action === "status") {
      const status = await amazonConnectionStatus();
      return json(200, { ok: true, ...status });
    }
  } catch {
    /* fall through to sync */
  }

  if (!isNetlifyScheduleEvent(event) && event.httpMethod && event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  try {
    const result = await withLock("amazon-sync", 180, async () => runAmazonSyncJob());
    return json(200, { ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { ok: false, error: message });
  }
}

export const invoke = wrapHandler("amazon-sync", handle);

export default asNetlifyFunction(invoke);
