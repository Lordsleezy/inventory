export function ebayHosts(env = process.env.EBAY_ENV) {
  const live = env === "production";
  return {
    auth: live ? "https://auth.ebay.com" : "https://auth.sandbox.ebay.com",
    api: live ? "https://api.ebay.com" : "https://api.sandbox.ebay.com",
    www: live ? "https://www.ebay.com" : "https://www.sandbox.ebay.com",
  };
}

export function ebayItemViewUrl(listingId, env = process.env.EBAY_ENV) {
  const id = String(listingId ?? "").trim();
  if (!id) return null;
  return `${ebayHosts(env).www}/itm/${encodeURIComponent(id)}`;
}

export function ebayRuName(ruName = process.env.EBAY_RU_NAME) {
  const value = String(ruName ?? "").trim();
  if (!value) throw new Error("EBAY_RU_NAME is missing. Create the redirect in the eBay developer portal.");
  if (/^https?:/i.test(value)) {
    throw new Error("EBAY_RU_NAME must be the RuName from the eBay portal, not the Auth Accepted URL.");
  }
  return value;
}

/** Listing uses category condition IDs from ebay-conditions.mjs, not this enum. */
export function ebayCondition(floor) {
  const c = String(floor ?? "")
    .trim()
    .toLowerCase();
  if (c === "new") return "NEW";
  if (c.includes("open")) return "LIKE_NEW";
  if (c.includes("excellent")) return "USED_EXCELLENT";
  if (c.includes("very good")) return "USED_VERY_GOOD";
  if (c === "good") return "USED_GOOD";
  if (c.includes("fair") || c.includes("poor")) return "USED_ACCEPTABLE";
  if (c.includes("part")) return "FOR_PARTS_OR_NOT_WORKING";
  return "USED_GOOD";
}

export const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.notification.subscription",
].join(" ");
