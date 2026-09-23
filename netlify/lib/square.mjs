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
import { Client, Environment } from "square/legacy";
import { decryptSecret, encryptSecret, serviceClient } from "./server.mjs";

function env() {
  return (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? Environment.Production
    : Environment.Sandbox;
}

export function squareClient(accessToken, environment = env()) {
  return new Client({
    // Prefer bearerAuthCredentials — accessToken alone is deprecated in square-legacy.
    bearerAuthCredentials: { accessToken },
    environment,
  });
}

/**
 * Retrieve a location, retrying the opposite Square environment on 401/403.
 * Catches sandbox token + production SQUARE_ENVIRONMENT (and the reverse).
 */
export async function resolveSquareLocation(accessToken, locationId) {
  const primary = env();
  const secondary = primary === Environment.Sandbox ? Environment.Production : Environment.Sandbox;
  let lastErr = null;

  for (const environment of [primary, secondary]) {
    try {
      const client = squareClient(accessToken, environment);
      const { result } = await client.locationsApi.retrieveLocation(locationId);
      return {
        location: result.location || null,
        environment,
        sandbox: environment === Environment.Sandbox,
        flipped: environment !== primary,
      };
    } catch (err) {
      lastErr = err;
      const status = err?.statusCode;
      if (status !== 401 && status !== 403) break;
    }
  }

  // Last resort: list locations on primary and match by id (some tokens can list but not retrieve).
  try {
    const client = squareClient(accessToken, primary);
    const { result } = await client.locationsApi.listLocations();
    const location = (result.locations || []).find((l) => l.id === locationId) || null;
    if (location) {
      return { location, environment: primary, sandbox: primary === Environment.Sandbox, flipped: false };
    }
    const ids = (result.locations || []).map((l) => l.id).filter(Boolean);
    const err = new Error(
      `Square location ${locationId} not in this account. Available: ${ids.slice(0, 8).join(", ") || "(none)"}`,
    );
    err.statusCode = 404;
    throw err;
  } catch (err) {
    if (err?.statusCode === 404 && err.message?.includes("not in this account")) throw err;
    throw lastErr || err;
  }
}

export function squareHttpErrorMessage(err, locationId) {
  const status = err?.statusCode;
  const detail = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403) {
    const environment = (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() === "production"
      ? "production"
      : "sandbox";
    const base =
      `Square rejected the access token (HTTP ${status}) for location ${locationId} in ${environment}. ` +
      `Reconnect Square on the register (Settings → Connect Square).`;
    if (environment === "production") return base;
    return (
      `${base} ` +
      `If you use a Netlify env token, set SQUARE_SANDBOX_ACCESS_TOKEN to a fresh Sandbox Access Token from ` +
      `Developer Console → Sandbox → Credentials, and SQUARE_SANDBOX_LOCATION_ID to that account’s Location ID.`
    );
  }
  return `Could not verify Square location ${locationId}: ${detail}`;
}

export async function exchangeSquareCode(code) {
  const client = new Client({ environment: env() });
  const redirectUri = process.env.SQUARE_REDIRECT_URL || process.env.OAUTH_REDIRECT_URI;
  if (!redirectUri) throw new Error("SQUARE_REDIRECT_URL (or OAUTH_REDIRECT_URI) is not set");
  const { result } = await client.oAuthApi.obtainToken({
    clientId: process.env.SQUARE_APPLICATION_ID,
    clientSecret: process.env.SQUARE_APPLICATION_SECRET,
    code,
    grantType: "authorization_code",
    redirectUri,
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
    // Phone Connections OAuth historically wrote only to `connections`.
    const { data: legacy } = await sb
      .from("connections")
      .select("token_ciphertext, refresh_ciphertext, expires_at, location_id, status")
      .eq("store_id", storeId)
      .eq("provider", "square")
      .maybeSingle();
    if (legacy?.token_ciphertext && legacy.status === "connected") {
      const accessToken = decryptSecret(legacy.token_ciphertext);
      const refreshToken = legacy.refresh_ciphertext ? decryptSecret(legacy.refresh_ciphertext) : null;
      try {
        await upsertEncryptedSquareTokens(
          storeId,
          {
            accessToken,
            refreshToken: refreshToken || undefined,
            expiresAt: legacy.expires_at,
          },
          { location_id: legacy.location_id || process.env.SQUARE_SANDBOX_LOCATION_ID || null },
        );
      } catch {
        /* still return the decrypted token */
      }
  return {
        accessToken,
        locationId: legacy.location_id || process.env.SQUARE_SANDBOX_LOCATION_ID || null,
        locationName: null,
        merchantId: null,
        sandbox: (process.env.SQUARE_ENVIRONMENT || "sandbox") !== "production",
        source: "connections_mirrored",
      };
    }
    if ((process.env.SQUARE_ENVIRONMENT || "sandbox") !== "production" && process.env.SQUARE_SANDBOX_ACCESS_TOKEN) {
      return {
        accessToken: process.env.SQUARE_SANDBOX_ACCESS_TOKEN,
        locationId: process.env.SQUARE_SANDBOX_LOCATION_ID || null,
        locationName: null,
        merchantId: null,
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
    locationName: row.location_name || null,
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
  const body = {
    idempotencyKey: `refund_${paymentId}_${amountCents || "full"}`,
    paymentId,
    reason: reason || "Ticket could not finalize",
  };
  if (amountCents != null) {
    body.amountMoney = { amount: BigInt(amountCents), currency: "USD" };
  }
  const { result } = await client.refundsApi.refundPayment(body);
  return result;
}
