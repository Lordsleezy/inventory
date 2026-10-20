/**
 * TikTok Shop returns sync (manual + future cron).
 * Until Partner API credentials exist, returns status + setup checklist only.
 */
import { json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import {
  syncTikTokReturns,
  tiktokConfigured,
  tiktokSetupChecklist,
  ingestTikTokFixture,
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
      configured: tiktokConfigured(),
      checklist: tiktokSetupChecklist(),
    });
  }

  if (body?.action === "fixture" && body.fixture) {
    // Dev-only helper — requires service role env on the function.
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
    const result = await syncTikTokReturns(body.store_id || STORE_DEFAULT);
    return json(200, { ok: true, ...result });
  } catch (err) {
    return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export const invoke = wrapHandler("tiktok-returns-sync", handle);
export default asNetlifyFunction(invoke);
