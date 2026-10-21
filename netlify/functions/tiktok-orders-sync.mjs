/**
 * TikTok Shop order poll (scheduled). Floor sale → delist elsewhere.
 */
import { json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import {
  tiktokConnectionStatus,
  runTikTokOrdersSyncJob,
  ensureTikTokTokenFresh,
  STORE_DEFAULT,
} from "../lib/tiktok-shop.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };

  try {
    const body = typeof event.body === "string" ? JSON.parse(event.body || "{}") : event.body || {};
    if (body?.action === "status") {
      const status = await tiktokConnectionStatus(body.store_id || STORE_DEFAULT);
      return json(200, { ok: true, ...status });
    }
  } catch {
    /* fall through */
  }

  if (!isNetlifyScheduleEvent(event) && event.httpMethod && event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  try {
    const result = await withLock("tiktok-orders-sync", 180, async () => {
      await ensureTikTokTokenFresh(STORE_DEFAULT).catch(() => undefined);
      return runTikTokOrdersSyncJob(STORE_DEFAULT);
    });
    return json(200, { ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { ok: false, error: message });
  }
}

export const invoke = wrapHandler("tiktok-orders-sync", handle);
export default asNetlifyFunction(invoke);
