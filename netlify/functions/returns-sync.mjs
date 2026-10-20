/**
 * Scheduled returns intake: Amazon MFN returns report + TikTok stub.
 * Schedule: every 30 minutes (see netlify.toml).
 */
import { json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { syncAmazonReturns } from "../lib/amazon-returns.mjs";
import { syncTikTokReturns, tiktokConfigured, tiktokSetupChecklist } from "../lib/tiktok-shop.mjs";
import { STORE_DEFAULT } from "../lib/returns.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };

  let body = {};
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  } catch {
    body = {};
  }

  if (body?.action === "status") {
    return json(200, {
      ok: true,
      amazon: "reports_api_GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE",
      tiktok_configured: tiktokConfigured(),
      tiktok_checklist: tiktokConfigured() ? [] : tiktokSetupChecklist(),
    });
  }

  if (!isNetlifyScheduleEvent(event) && event.httpMethod && event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  try {
    const result = await withLock("returns-sync", 240, async () => {
      const storeId = body.store_id || STORE_DEFAULT;
      const amazon = await syncAmazonReturns(storeId, {
        lookbackDays: body.lookback_days,
        attempts: body.attempts,
        delayMs: body.delay_ms,
      }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      const tiktok = await syncTikTokReturns(storeId).catch((err) => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }));
      return { amazon, tiktok };
    });
    return json(200, { ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { ok: false, error: message });
  }
}

export const invoke = wrapHandler("returns-sync", handle);
export default asNetlifyFunction(invoke);
