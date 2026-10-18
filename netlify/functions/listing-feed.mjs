/**
 * GET /listing-feed
 * Read-only live inventory for marketplace listing agents.
 * Auth: x-listing-feed-key. Uses the service client for selects and signed photo URLs only.
 */
import { asNetlifyFunction } from "../lib/floor-log.mjs";
import {
  AUTH_FAIL_LIMIT,
  RATE_LIMIT,
  consumeRate,
  headerValue,
  keysMatch,
  loadListingFeed,
  parseListingFeedQuery,
} from "../lib/listing-feed.mjs";
import { serviceClient } from "../lib/server.mjs";

function clientIp(headers) {
  return headerValue(headers, "x-nf-client-connection-ip")
    || headerValue(headers, "x-forwarded-for").split(",")[0].trim()
    || "unknown";
}

function respond(status, body, extra = {}) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-listing-feed-key",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      ...extra,
    },
    body: body == null ? "" : JSON.stringify(body),
  };
}

async function handle(event) {
  if (event?.httpMethod === "OPTIONS") return respond(200, null);
  if (event?.httpMethod !== "GET") return respond(405, { ok: false, error: "method_not_allowed" });

  const headers = event.headers || {};
  const ip = clientIp(headers);
  const provided = headerValue(headers, "x-listing-feed-key");
  if (!keysMatch(provided, process.env.LISTING_FEED_KEY || "")) {
    const limited = consumeRate(`fail:${ip}`, AUTH_FAIL_LIMIT);
    if (!limited.ok) {
      return respond(429, { ok: false, error: "rate_limited" }, { "Retry-After": String(limited.reset) });
    }
    return respond(401, { ok: false, error: "unauthorized" });
  }

  const limited = consumeRate(`ok:${ip}`, RATE_LIMIT);
  if (!limited.ok) {
    return respond(429, { ok: false, error: "rate_limited" }, { "Retry-After": String(limited.reset) });
  }
  const rateHeaders = {
    "X-RateLimit-Limit": String(limited.limit),
    "X-RateLimit-Remaining": String(limited.remaining),
  };

  try {
    const query = parseListingFeedQuery(event.queryStringParameters || {});
    const result = await loadListingFeed(serviceClient(), query);
    return respond(result.status, result.body, rateHeaders);
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("listing_feed_failed", err instanceof Error ? err.message : String(err));
    return respond(status, { ok: false, error: status === 400 ? err.message : "feed_failed" }, rateHeaders);
  }
}

export default asNetlifyFunction(handle);
