import { json, corsHeaders, staffFromEvent } from "../lib/server.mjs";
import {
  getStoreSquareAccess,
  resolveSquareLocation,
  squareClient,
  squareHttpErrorMessage,
} from "../lib/square.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { Environment } from "square/legacy";

/** Countries where Mobile Payments SDK can authorize (sandbox + production). */
const MPSDK_COUNTRIES = new Set(["US", "CA", "GB", "AU"]);

/**
 * Mint credentials for the phone Mobile Payments SDK (authorize).
 * Returns access token + location + diagnostics for the phone UI.
 */
async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  const ctx = await staffFromEvent(event);
  const access = await getStoreSquareAccess(ctx.staff.store_id);
  if (!access.locationId) {
    return json(409, { error: "square_location_required" });
  }

  const applicationId = process.env.SQUARE_APPLICATION_ID || null;
  if (!applicationId) {
    return json(500, {
      error: "square_application_id_missing",
      message:
        "Netlify SQUARE_APPLICATION_ID is unset. Set it to the same Application ID baked into the iOS build (Codemagic appstore group). Mismatch is the #1 cause of authorization_unsupported_country on iOS.",
    });
  }

  const envSandbox = (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() !== "production";
  let locationName = access.locationName || null;
  let locationCountry = null;
  let locationStatus = null;
  let merchantId = access.merchantId || null;
  let merchantCountry = null;
  let verificationError = null;
  let tokenSandbox = access.sandbox ?? envSandbox;

  try {
    const verified = await resolveSquareLocation(access.accessToken, access.locationId);
    const loc = verified.location;
    if (loc) {
      locationName = loc.name || locationName;
      locationCountry = loc.country || null;
      locationStatus = loc.status || null;
      merchantId = loc.merchantId || merchantId;
    }
    tokenSandbox = verified.sandbox;
    if (verified.flipped) {
      verificationError =
        `SQUARE_ENVIRONMENT is ${envSandbox ? "sandbox" : "production"} but this access token only works against ` +
        `${verified.sandbox ? "sandbox" : "production"}. Update Netlify SQUARE_ENVIRONMENT (and Application ID) to match.`;
    }

    // Merchant country (Square forum: confirm seller country independently of location).
    try {
      const env = tokenSandbox ? Environment.Sandbox : Environment.Production;
      const client = squareClient(access.accessToken, env);
      const { result } = await client.merchantsApi.retrieveMerchant(merchantId || "me");
      const merchant = result.merchant;
      if (merchant) {
        merchantId = merchant.id || merchantId;
        merchantCountry = merchant.country || null;
      }
    } catch {
      /* optional diagnostic */
    }
  } catch (err) {
    verificationError = squareHttpErrorMessage(err, access.locationId);
  }

  if (locationCountry && !MPSDK_COUNTRIES.has(locationCountry)) {
    return json(409, {
      error: "square_location_unsupported_country",
      message: `Square location ${access.locationId} is in ${locationCountry}. Mobile Payments SDK only supports US, CA, GB, AU.`,
      locationId: access.locationId,
      locationName,
      locationCountry,
      merchantCountry,
      applicationId,
      sandbox: tokenSandbox,
      source: access.source || null,
    });
  }

  const idIsSandbox = applicationId.startsWith("sandbox-");
  if (idIsSandbox !== Boolean(tokenSandbox)) {
    return json(409, {
      error: "square_app_id_environment_mismatch",
      message: `SQUARE_APPLICATION_ID looks ${idIsSandbox ? "sandbox" : "production"} but the access token is ${tokenSandbox ? "sandbox" : "production"}. Codemagic IPA and Netlify must use the same Application ID.`,
      applicationId,
      sandbox: tokenSandbox,
      locationId: access.locationId,
      locationCountry,
      merchantCountry,
      source: access.source || null,
      verificationError,
    });
  }

  return json(200, {
    accessToken: access.accessToken,
    locationId: access.locationId,
    locationName,
    locationCountry,
    locationStatus,
    merchantId,
    merchantCountry,
    sandbox: tokenSandbox,
    applicationId,
    source: access.source || null,
    verificationError,
  });
}

export const handler = wrapHandler("square-mobile-auth", async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "square_not_connected") return json(409, { error: msg });
    throw err;
  }
});
