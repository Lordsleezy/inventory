import { randomBytes } from "node:crypto";
import { ownerFromEvent, json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { hopUrl } from "../lib/oauth-authorize.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  try {
    const provider = event.queryStringParameters?.provider;
    if (!provider || !["square", "ebay", "amazon", "tiktok"].includes(provider)) {
      return json(400, { error: "unknown_provider" });
    }
    if (provider === "tiktok") {
      const key = (process.env.TIKTOK_SHOP_APP_KEY || "").trim();
      const secret = (process.env.TIKTOK_SHOP_APP_SECRET || "").trim();
      if (!key || !secret) {
        return json(503, {
          error: "tiktok_env_missing",
          message: "Set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET in Netlify before authorizing.",
        });
      }
    }
    if (provider === "amazon" && process.env.AMAZON_ACCOUNT_TYPE === "individual") {
      return json(400, { error: "amazon_individual_is_manual", message: "Amazon Individual has no Connect. Mark listings by hand." });
    }
    if (provider === "ebay" && ebayDisabled()) return json(503, { error: "ebay_disabled" });
    const { user, staff } = await ownerFromEvent(event);
    const nonce = randomBytes(24).toString("hex");
    const roleParam = String(event.queryStringParameters?.role || "").trim();
    const meta =
      provider === "ebay"
        ? { role: roleParam === "selling" ? "selling" : "orders_only" }
        : {};
    const sb = serviceClient();
    const ins = await sb.from("oauth_states").insert({
      store_id: staff.store_id,
      user_id: user.id,
      provider,
      nonce,
      meta,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    if (ins.error) return json(500, { error: ins.error.message });
    return json(200, { url: hopUrl(event, nonce), role: meta.role || null });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "not_owner") {
      return json(403, {
        error: "not_owner",
        message: "A Floor store owner or portal admin must connect Square, eBay, Amazon, or TikTok Shop.",
      });
    }
    return json(401, { error: message });
  }
}

export const invoke = wrapHandler("oauth-start", handle);

export default asNetlifyFunction(invoke);
