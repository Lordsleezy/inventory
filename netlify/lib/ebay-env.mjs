export function ebayDisabled(env = process.env.EBAY_DISABLED) {
  return /^(1|true|yes|on)$/i.test(String(env || "").trim());
}

/**
 * Legacy global orders-only flag. Prefer per-account role on ebay_accounts:
 * selling accounts always list; orders_only accounts never list.
 * When unset, defaults to true for backward compatibility with the Vendoo cutover.
 */
export function ebayOrdersOnly(env = process.env.EBAY_ORDERS_ONLY) {
  if (env == null || String(env).trim() === "") return true;
  return /^(1|true|yes|on)$/i.test(String(env).trim());
}

/** @param {{ role?: string, status?: string } | null} account */
export function ebayListingAllowed(account = null) {
  if (ebayDisabled()) return false;
  if (account) return account.role === "selling" && account.status === "connected";
  // No account context: honor global flag (legacy single-connection path).
  return !ebayOrdersOnly();
}

export function requireEbayEnabled() {
  if (ebayDisabled()) throw new Error("eBay integration is disabled for this store.");
}

/** @param {{ role?: string, status?: string } | null} account */
export function requireEbayListingEnabled(account = null) {
  requireEbayEnabled();
  if (!ebayListingAllowed(account)) {
    throw new Error(
      "eBay is connected for order sync only. Connect a selling account (or set EBAY_ORDERS_ONLY=false) before creating or ending listings.",
    );
  }
}

/** Legacy personal seller username used for orders-only reconnect hints. */
export function ebayRequiredUsername(env = process.env.EBAY_REQUIRED_USERNAME) {
  return String(env || "pgg124-5").trim().toLowerCase();
}

export function marketplaceIdFromEnv(env = process.env.EBAY_MARKETPLACE_ID) {
  return String(env || "EBAY_US").trim() || "EBAY_US";
}

export function ebayHosts(env = process.env.EBAY_ENV) {
  const live = env === "production";
  return {
    auth: live ? "https://auth.ebay.com" : "https://auth.sandbox.ebay.com",
    api: live ? "https://api.ebay.com" : "https://api.sandbox.ebay.com",
    // Sell Finances (fees + shipping labels) is served from apiz, not api.
    finances: live ? "https://apiz.ebay.com" : "https://apiz.sandbox.ebay.com",
    www: live ? "https://www.ebay.com" : "https://www.sandbox.ebay.com",
  };
}

export function ebayItemViewUrl(listingId, env = process.env.EBAY_ENV) {
  const id = String(listingId ?? "").trim();
  if (!id) return null;
  return `${ebayHosts(env).www}/itm/${encodeURIComponent(id)}`;
}

export function ebayOrderViewUrl(orderId, env = process.env.EBAY_ENV) {
  const id = String(orderId ?? "").trim();
  if (!id) return null;
  // Seller hub order details deep link.
  return `${ebayHosts(env).www}/mesh/ord/details?orderid=${encodeURIComponent(id)}`;
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

/** Full listing scopes — always requested when connecting a selling account. */
export const EBAY_LISTING_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.finances",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/commerce.notification.subscription",
].join(" ");

/** Orders + mark-shipped + finances (actual fees / eBay label spend). No inventory/listing scopes. */
export const EBAY_ORDERS_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.finances",
].join(" ");

/** Default scopes for legacy callers; prefer scopesForRole / authorizeUrl(role). */
export const EBAY_OAUTH_SCOPES = ebayOrdersOnly() ? EBAY_ORDERS_OAUTH_SCOPES : EBAY_LISTING_OAUTH_SCOPES;

export function oauthScopesForRole(role) {
  return role === "selling" ? EBAY_LISTING_OAUTH_SCOPES : EBAY_ORDERS_OAUTH_SCOPES;
}
