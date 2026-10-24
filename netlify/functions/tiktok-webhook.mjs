/**
 * TikTok Shop webhook receiver (order / return notifications when Partner Center is configured).
 * Without APP credentials, returns a clear error. Never invents order success.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import {
  ingestTikTokOrder,
  syncTikTokReturns,
  tiktokAppCredsPresent,
  STORE_DEFAULT,
} from "../lib/tiktok-shop.mjs";

function verifySignature(rawBody, signature) {
  const secret = (process.env.TIKTOK_SHOP_APP_SECRET || "").trim();
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };

  if (event.httpMethod === "GET") {
    // Partner Center challenge / health
    return json(200, {
      ok: true,
      configured: tiktokAppCredsPresent(),
      note: tiktokAppCredsPresent()
        ? "Webhook ready — register this URL in Partner Center."
        : "Set TIKTOK_SHOP_APP_KEY / TIKTOK_SHOP_APP_SECRET before enabling webhooks.",
    });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  if (!tiktokAppCredsPresent()) {
    return json(503, {
      ok: false,
      error: "tiktok_env_missing",
      message: "TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET required for webhook processing.",
    });
  }

  const raw = typeof event.body === "string" ? event.body : JSON.stringify(event.body || {});
  const sig = String(
    event.headers?.["x-tts-signature"] ||
    event.headers?.["X-Tts-Signature"] ||
    event.headers?.["authorization"] ||
    event.headers?.Authorization ||
    "",
  ).replace(/^Bearer\s+/i, "").trim();
  // Unsigned posts must not create orders. Partner Center always signs with the app secret.
  if (!verifySignature(raw, sig)) {
    return json(401, { ok: false, error: "invalid_signature" });
  }

  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const type = String(payload.type || payload.event_type || payload.notification_type || "").toLowerCase();
  const data = payload.data || payload;
  const storeId = STORE_DEFAULT;

  try {
    if (/order|trade/.test(type) || data?.order_id || data?.order) {
      const order = data.order || data;
      const result = await ingestTikTokOrder(storeId, order);
      return json(200, { ok: true, handled: "order", result });
    }
    if (/return|refund/.test(type)) {
      const result = await syncTikTokReturns(storeId);
      return json(200, { ok: true, handled: "returns_sync", result });
    }
    return json(200, {
      ok: true,
      handled: "noop",
      note: "Unrecognized event type — scheduled tiktok-orders-sync / tiktok-returns-sync remain authoritative.",
      type: type || null,
    });
  } catch (err) {
    return json(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export const invoke = wrapHandler("tiktok-webhook", handle);
export default asNetlifyFunction(invoke);
