import { requireEnv } from "./server.mjs";
import { EBAY_OAUTH_SCOPES, ebayHosts, ebayRuName } from "./ebay-env.mjs";

const SCOPES = {
  square: "MERCHANT_PROFILE_READ PAYMENTS_WRITE PAYMENTS_WRITE_IN_PERSON",
  ebay: EBAY_OAUTH_SCOPES,
};

export function authorizeUrl(provider, nonce) {
  if (provider === "square") {
    const redirectUri = requireEnv("OAUTH_REDIRECT_URI");
    const host =
      process.env.SQUARE_ENV === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";
    const id = requireEnv("SQUARE_APPLICATION_ID");
    return `${host}/oauth2/authorize?client_id=${encodeURIComponent(id)}&scope=${encodeURIComponent(SCOPES.square)}&session=false&state=${nonce}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
  if (provider === "ebay") {
    const { auth } = ebayHosts(process.env.EBAY_ENV);
    const id = requireEnv("EBAY_CLIENT_ID");
    const ruName = ebayRuName(process.env.EBAY_RU_NAME);
    return `${auth}/oauth2/authorize?client_id=${encodeURIComponent(id)}&response_type=code&redirect_uri=${encodeURIComponent(ruName)}&scope=${encodeURIComponent(SCOPES.ebay)}&state=${nonce}`;
  }
  if (provider === "amazon") {
    const appId = requireEnv("AMAZON_APPLICATION_ID");
    return `https://sellercentral.amazon.com/apps/authorize/consent?application_id=${encodeURIComponent(appId)}&version=beta&state=${nonce}`;
  }
  throw new Error("unknown_provider");
}

export function publicOrigin(event) {
  const redirect = process.env.OAUTH_REDIRECT_URI || "";
  try {
    if (redirect) return new URL(redirect).origin;
  } catch {
    /* ignore */
  }
  const host = event?.headers?.host || event?.headers?.Host || "";
  if (host) return `https://${host}`;
  return "https://inventoryobi.netlify.app";
}

export function hopUrl(event, nonce) {
  return `${publicOrigin(event)}/.netlify/functions/oauth-go?n=${encodeURIComponent(nonce)}`;
}
