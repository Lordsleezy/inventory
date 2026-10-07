import { randomBytes } from "node:crypto";
import { json, corsHeaders } from "../lib/server.mjs";
import { portalAdminFromEvent } from "../lib/portal-auth.mjs";
import { hopUrl } from "../lib/oauth-authorize.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
import {
  disconnectEbay,
  ebayConnectionStatus,
  pollEbayOrders,
} from "../lib/ebay.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (ebayDisabled()) return json(503, { ok: false, error: "eBay integration is fully disabled (EBAY_DISABLED)." });
  let ctx;
  try {
    ctx = await portalAdminFromEvent(event);
  } catch (err) {
    return json(err.status || 401, { ok: false, error: err.message || "unauthorized" });
  }
  const storeId = ctx.storeId;
  const body = event.httpMethod === "GET" ? { action: "status" } : JSON.parse(event.body || "{}");
  const action = String(body.action || "status");

  if (action === "status") {
    return json(200, { ok: true, ...(await ebayConnectionStatus(storeId)) });
  }
  if (action === "connect") {
    if (!ctx.userId) return json(400, { error: "Sign in from the admin portal to connect eBay." });
    const nonce = randomBytes(24).toString("hex");
    const ins = await ctx.sb.from("oauth_states").insert({
      store_id: storeId,
      user_id: ctx.userId,
      provider: "ebay",
      nonce,
      return_to: "https://admin.openboxindustries.com/?page=marketplaces",
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    if (ins.error) return json(500, { error: ins.error.message });
    return json(200, { ok: true, url: hopUrl(event, nonce) });
  }
  if (action === "disconnect") {
    await disconnectEbay(storeId);
    return json(200, { ok: true, ...(await ebayConnectionStatus(storeId)) });
  }
  if (action === "sync_now") {
    const status = await ebayConnectionStatus(storeId);
    if (!status.connected) return json(400, { ok: false, error: "eBay is not connected." });
    const orders = await pollEbayOrders(storeId);
    return json(200, { ok: true, orders, ...(await ebayConnectionStatus(storeId)) });
  }
  return json(400, { error: "unknown_action" });
}

export const handler = wrapHandler("ebay-connection", handle);
