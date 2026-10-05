import { json, corsHeaders, requireEnv } from "../lib/server.mjs";
import { notificationChallenge, pollAllStores, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { handleDeletionPost } from "../lib/ebay-account-deletion.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";

function endpointUrl(event) {
  return process.env.EBAY_NOTIFICATION_ENDPOINT || `https://${event.headers.host}/.netlify/functions/ebay-notify`;
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (ebayDisabled()) return json(410, { error: "eBay notifications are disabled." });
  if (event.httpMethod === "GET") {
    const challenge = event.queryStringParameters?.challenge_code;
    if (!challenge) return json(400, { error: "missing_challenge" });
    const token = requireEnv("EBAY_NOTIFICATION_TOKEN");
    return json(200, { challengeResponse: notificationChallenge(challenge, endpointUrl(event), token) });
  }
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  try {
    const body = JSON.parse(event.body || "{}");
    const topic = body.metadata?.topic || body.topic || "";
    const results = await pollAllStores();
    await withdrawOpenEbayTasks();
    return json(200, { ok: true, polled: results.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(400, { error: message });
  }
}

const regularHandler = wrapHandler("ebay-notify", handle);
export async function handler(event, context) {
  if (ebayDisabled()) return json(410, { error: "eBay notifications are disabled." });
  // The regular request logger includes POST bodies. Keep deletion identifiers
  // out of it, including when a forged notification fails verification.
  if (event.httpMethod === "POST") {
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "";
      if (JSON.parse(raw).metadata?.topic === "MARKETPLACE_ACCOUNT_DELETION")
        return handleDeletionPost(event);
    } catch { /* Regular handler returns a JSON error. */ }
  }
  return regularHandler(event, context);
}
