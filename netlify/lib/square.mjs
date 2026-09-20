/**
 * Square OAuth + token refresh (sandbox/production).
 * Tokens live encrypted in square_connections (CONNECTIONS_KEY). Never on the phone.
 *
 * Env (exact names):
 *   SQUARE_APPLICATION_ID, SQUARE_APPLICATION_SECRET
 *   SQUARE_ENVIRONMENT=sandbox|production
 *   SQUARE_REDIRECT_URL=https://<functions>/.netlify/functions/square-oauth-callback
 *   CONNECTIONS_KEY
 * Optional for sandbox without OAuth:
 *   SQUARE_SANDBOX_ACCESS_TOKEN  (Default Test Account token from Square console)
 *   SQUARE_SANDBOX_LOCATION_ID
 */
import { Client, Environment } from "square";
import { decryptSecret, encryptSecret, serviceClient } from "./server.mjs";

function env() {
  return (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? Environment.Production
    : Environment.Sandbox;
}

export function squareClient(accessToken) {
  return new Client({ accessToken, environment: env() });
}

export async function exchangeSquareCode(code) {
  const client = new Client({ environment: env() });
  const { result } = await client.oAuthApi.obtainToken({
    clientId: process.env.SQUARE_APPLICATION_ID,
    clientSecret: process.env.SQUARE_APPLICATION_SECRET,
    code,
    grantType: "authorization_code",
    redirectUri: process.env.SQUARE_REDIRECT_URL,
  });
  return result;
}

export async function refreshSquareToken(refreshToken) {
  const client = new Client({ environment: env() });
  const { result } = await client.oAuthApi.obtainToken({
    clientId: process.env.SQUARE_APPLICATION_ID,
    clientSecret: process.env.SQUARE_APPLICATION_SECRET,
    refreshToken,
    grantType: "refresh_token",
  });
  return result;
}

const REFRESH_SKEW_MS = 7 * 864e5; // refresh when < 7 days remain (30-day tokens)

/**
 * Returns a usable access token for a store.
 * Prefers square_connections (encrypted). Falls back to SQUARE_SANDBOX_ACCESS_TOKEN in sandbox.
 */
export async function getStoreSquareAccess(storeId) {
  const sb = serviceClient();
  const { data: row } = await sb.from("square_connections").select("*").eq("store_id", storeId).maybeSingle();

  if (!row?.access_token_enc) {
    if ((process.env.SQUARE_ENVIRONMENT || "sandbox") !== "production" && process.env.SQUARE_SANDBOX_ACCESS_TOKEN) {
      return {
        accessToken: process.env.SQUARE_SANDBOX_ACCESS_TOKEN,
        locationId: process.env.SQUARE_SANDBOX_LOCATION_ID || row?.location_id || null,
        merchantId: row?.merchant_id || null,
        sandbox: true,
        source: "env_sandbox_token",
      };
    }
    throw new Error("square_not_connected");
  }

  let access = decryptSecret(row.access_token_enc);
  let refresh = row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null;
  let expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;

  if (refresh && expiresAt && expiresAt - Date.now() < REFRESH_SKEW_MS) {
    const tokens = await refreshSquareToken(refresh);
    access = tokens.accessToken;
    refresh = tokens.refreshToken || refresh;
    expiresAt = tokens.expiresAt ? new Date(tokens.expiresAt).getTime() : Date.now() + 30 * 864e5;
    await sb
      .from("square_connections")
      .update({
        access_token_enc: encryptSecret(access),
        refresh_token_enc: refresh ? encryptSecret(refresh) : null,
        expires_at: new Date(expiresAt).toISOString(),
        merchant_id: tokens.merchantId || row.merchant_id,
        updated_at: new Date().toISOString(),
      })
      .eq("store_id", storeId);
  }

  return {
    accessToken: access,
    locationId: row.location_id || process.env.SQUARE_SANDBOX_LOCATION_ID || null,
    merchantId: row.merchant_id,
    sandbox: row.sandbox,
    source: "square_connections",
  };
}

export async function upsertEncryptedSquareTokens(storeId, tokens, extras = {}) {
  const sb = serviceClient();
  const expires = tokens.expiresAt ? new Date(tokens.expiresAt) : new Date(Date.now() + 30 * 864e5);
  await sb.from("square_connections").upsert({
    store_id: storeId,
    merchant_id: tokens.merchantId || extras.merchant_id || null,
    location_id: extras.location_id ?? null,
    location_name: extras.location_name ?? null,
    access_token_enc: encryptSecret(tokens.accessToken),
    refresh_token_enc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
    expires_at: expires.toISOString(),
    sandbox: (process.env.SQUARE_ENVIRONMENT || "sandbox") !== "production",
    updated_at: new Date().toISOString(),
  });
}

export async function refundSquarePayment(storeId, paymentId, amountCents, reason) {
  const { accessToken } = await getStoreSquareAccess(storeId);
  const client = squareClient(accessToken);
  const { result } = await client.refundsApi.refundPayment({
    idempotencyKey: `refund_${paymentId}_${amountCents || "full"}`,
    paymentId,
    amountMoney:
      amountCents != null
        ? { amount: BigInt(amountCents), currency: "USD" }
        : undefined,
    reason: reason || "Ticket could not finalize",
  });
  return result;
}
