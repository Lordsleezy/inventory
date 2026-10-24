/**
 * TikTok Shop returns sync (manual + cron).
 * Calls Partner return_refund search when tokens are present; otherwise status + checklist.
 * ingest_channel_return enqueues return_decision alerts (48h TikTok deadline in return_settings).
 */
import { json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import {
  syncTikTokReturns,
  tiktokConfigured,
  tiktokAppCredsPresent,
  tiktokSetupChecklist,
  ingestTikTokFixture,
  ensureTikTokTokenFresh,
  STORE_DEFAULT,
} from "../lib/tiktok-shop.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };

  let body = {};
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
  } catch {
    body = {};
  }

  if (body?.action === "status" || event.httpMethod === "GET") {
    return json(200, {
      ok: true,
      configured: tiktokConfigured() || tiktokAppCredsPresent(),
      app_creds: tiktokAppCredsPresent(),
      checklist: tiktokAppCredsPresent() ? [] : tiktokSetupChecklist(),
      decision_hours_tiktok: 48,
    });
  }

  if (body?.action === "fixture" && body.fixture) {
    try {
      const row = await ingestTikTokFixture(body.store_id || STORE_DEFAULT, body.fixture);
      return json(200, { ok: true, return: row });
    } catch (err) {
      return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (!isNetlifyScheduleEvent(event) && event.httpMethod && event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  try {
    const storeId = body.store_id || STORE_DEFAULT;
    await ensureTikTokTokenFresh(storeId).catch(() => undefined);
    const result = await syncTikTokReturns(storeId);
    return json(200, { ok: true, ...result });
  } catch (err) {
    return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export const invoke = wrapHandler("tiktok-returns-sync", handle);
export default asNetlifyFunction(invoke);
