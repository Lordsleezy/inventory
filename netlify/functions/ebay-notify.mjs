import { json, corsHeaders, requireEnv } from "../lib/server.mjs";
import { notificationChallenge, pollAllStores, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { authorizeEbayNotifyPost, handleDeletionPost } from "../lib/ebay-account-deletion.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";

function endpointUrl(event) {
  return process.env.EBAY_NOTIFICATION_ENDPOINT || `https://${event.headers.host}/.netlify/functions/ebay-notify`;
}

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
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
export async function invoke(event, context) {
  if (ebayDisabled()) return json(410, { error: "eBay notifications are disabled." });
  // The regular request logger includes POST bodies. Keep deletion identifiers
  // out of it, including when a forged notification fails verification.
  // Every other POST must carry a valid x-ebay-signature before any poll.
  if (event.httpMethod === "POST") {
    const gate = await authorizeEbayNotifyPost(event);
    if (gate.kind === "deletion") return handleDeletionPost(event);
    if (gate.kind === "stop") return gate.response;
  }
  return regularHandler(event, context);
}

export default asNetlifyFunction(invoke);
