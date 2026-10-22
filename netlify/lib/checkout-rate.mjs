/**
 * Public checkout limits. The database counter is shared across instances.
 * The in-memory counter is the fallback when that function is not deployed yet.
 */
import { consumeRate, headerValue } from "./listing-feed.mjs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, x-store-web-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

const SPECS = {
  pay: { name: "pay", limit: 8, windowMs: 600_000 },
  begin: { name: "begin", limit: 20, windowMs: 600_000 },
  rates: { name: "rates", limit: 40, windowMs: 600_000 },
  other: { name: "other", limit: 60, windowMs: 60_000 },
};

export function checkoutSpec(action) {
  if (action === "pay" || action === "begin" || action === "rates") return SPECS[action];
  return SPECS.other;
}

export function clientAddress(headers) {
  const direct = headerValue(headers, "x-nf-client-connection-ip");
  const forwarded = headerValue(headers, "x-forwarded-for").split(",")[0].trim();
  const raw = direct || forwarded || "unknown";
  return raw.replace(/[^0-9a-zA-Z:.]/g, "").slice(0, 80) || "unknown";
}

export function takeCheckoutRate(action, ip, now = Date.now(), consume = consumeRate) {
  const spec = checkoutSpec(action);
  const id = `checkout:${spec.name}:${String(ip || "unknown").slice(0, 80)}`;
  return consume(id, spec.limit, now, spec.windowMs);
}

export function rateLimited(resetSeconds) {
  const retry = Math.max(1, Number(resetSeconds) || 1);
  return {
    statusCode: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retry),
      ...corsHeaders(),
    },
    body: JSON.stringify({ error: "rate_limited", retry_after: retry }),
  };
}

/** @returns {Promise<{statusCode:number,headers:object,body:string}|null>} */
export async function enforceCheckoutRate(sb, event, action) {
  const spec = checkoutSpec(action);
  const ip = clientAddress(event?.headers);
  const id = `checkout:${spec.name}:${ip}`;
  try {
    const { data, error } = await sb.rpc("consume_public_rate", {
      p_id: id,
      p_limit: spec.limit,
      p_window_seconds: Math.round(spec.windowMs / 1000),
    });
    if (!error && data && typeof data.ok === "boolean") {
      return data.ok ? null : rateLimited(data.reset);
    }
  } catch {
    /* Fall through to the per-instance counter. */
  }
  const hit = takeCheckoutRate(action, ip);
  return hit.ok ? null : rateLimited(hit.reset);
}
