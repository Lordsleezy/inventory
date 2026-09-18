import { randomBytes } from "node:crypto";
import { ownerFromEvent, json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { hopUrl } from "../lib/oauth-authorize.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const provider = event.queryStringParameters?.provider;
    if (!provider || !["square", "ebay", "amazon"].includes(provider)) {
      return json(400, { error: "unknown_provider" });
    }
    if (provider === "amazon" && process.env.AMAZON_ACCOUNT_TYPE === "individual") {
      return json(400, { error: "amazon_individual_is_manual", message: "Amazon Individual has no Connect. Mark listings by hand." });
    }
    const { user, staff } = await ownerFromEvent(event);
    const nonce = randomBytes(24).toString("hex");
    const sb = serviceClient();
    const ins = await sb.from("oauth_states").insert({
      store_id: staff.store_id,
      user_id: user.id,
      provider,
      nonce,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    if (ins.error) return json(500, { error: ins.error.message });
    return json(200, { url: hopUrl(event, nonce) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "not_owner") {
      return json(403, {
        error: "not_owner",
        message: "Only the store owner can connect Square, eBay, or Amazon. Sign in as the owner.",
      });
    }
    return json(401, { error: message });
  }
}
