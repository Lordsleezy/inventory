import { randomBytes } from "node:crypto";
import { ownerFromEvent, json, corsHeaders, serviceClient, requireEnv } from "../lib/server.mjs";

const SCOPES = {
  square: "MERCHANT_PROFILE_READ PAYMENTS_WRITE PAYMENTS_WRITE_IN_PERSON",
  ebay: [
    "https://api.ebay.com/oauth/api_scope/sell.inventory",
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
    "https://api.ebay.com/oauth/api_scope/sell.account",
    "https://api.ebay.com/oauth/api_scope/sell.marketing",
  ].join(" "),
};

function authorizeUrl(provider, nonce) {
  const redirectUri = requireEnv("OAUTH_REDIRECT_URI");
  if (provider === "square") {
    const host =
      process.env.SQUARE_ENV === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";
    const id = requireEnv("SQUARE_APPLICATION_ID");
    return `${host}/oauth2/authorize?client_id=${encodeURIComponent(id)}&scope=${encodeURIComponent(SCOPES.square)}&session=false&state=${nonce}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  if (provider === "ebay") {
    const host =
      process.env.EBAY_ENV === "production" ? "https://auth.ebay.com" : "https://auth.sandbox.ebay.com";
    const id = requireEnv("EBAY_CLIENT_ID");
    return `${host}/oauth2/authorize?client_id=${encodeURIComponent(id)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES.ebay)}&state=${nonce}`;
  }
  if (provider === "amazon") {
    const appId = requireEnv("AMAZON_APPLICATION_ID");
    return `https://sellercentral.amazon.com/apps/authorize/consent?application_id=${encodeURIComponent(appId)}&version=beta&state=${nonce}`;
  }
  throw new Error("unknown_provider");
}

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
    return json(200, { url: authorizeUrl(provider, nonce) });
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
