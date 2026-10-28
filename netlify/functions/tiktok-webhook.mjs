/** Store signed TikTok Shop notifications for a later integration phase. No order or return side effects. */
import { createHash } from "node:crypto";
import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { tiktokAppCredsPresent, STORE_DEFAULT } from "../lib/tiktok-shop.mjs";
import { verifyTikTokWebhookSignature } from "../lib/tiktok-webhook-signature.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  if (event.httpMethod === "GET") return json(200, { ok: true, configured: tiktokAppCredsPresent(), note: "Webhook receiver stores verified events only." });
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  if (!tiktokAppCredsPresent()) return json(503, { ok: false, error: "tiktok_env_missing" });
  const raw = typeof event.body === "string" ? event.body : JSON.stringify(event.body || {});
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const signature = String(headers.authorization || headers["x-tts-signature"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!verifyTikTokWebhookSignature(raw, signature)) return json(401, { ok: false, error: "invalid_signature" });
  let payload;
  try { payload = JSON.parse(raw || "{}"); } catch { return json(400, { ok: false, error: "invalid_json" }); }
  const eventType = String(payload.type || payload.event_type || payload.notification_type || payload.event || "unknown");
  const externalId = payload.id || payload.event_id || payload.eventId || payload.data?.event_id;
  const eventId = externalId ? String(externalId) : createHash("sha256").update(`${eventType}\n${raw}`).digest("hex");
  const { error } = await serviceClient().from("tiktok_webhook_events").upsert({
    store_id: STORE_DEFAULT, provider_event_id: eventId, event_type: eventType, payload, processing_state: "received",
  }, { onConflict: "store_id,provider_event_id", ignoreDuplicates: true });
  if (error) return json(500, { ok: false, error: "event_store_failed" });
  return json(200, { ok: true, event_id: eventId, stored: true, acted_on: false });
}

export const invoke = wrapHandler("tiktok-webhook", handle);
export default asNetlifyFunction(invoke);
