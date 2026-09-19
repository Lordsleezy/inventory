import { json, corsHeaders, requireEnv } from "../lib/server.mjs";
import { notificationChallenge, pollAllStores, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

function endpointUrl(event) {
  return process.env.EBAY_NOTIFICATION_ENDPOINT || `https://${event.headers.host}/.netlify/functions/ebay-notify`;
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
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
    if (topic === "MARKETPLACE_ACCOUNT_DELETION") {
      return json(200, { ok: true });
    }
    const results = await pollAllStores();
    await withdrawOpenEbayTasks();
    return json(200, { ok: true, polled: results.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(400, { error: message });
  }
}

export const handler = wrapHandler("ebay-notify", handle);
