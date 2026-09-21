import { json, corsHeaders, staffFromEvent } from "../lib/server.mjs";
import {
  getStoreSquareAccess,
  resolveSquareLocation,
  squareHttpErrorMessage,
} from "../lib/square.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

/** Countries where Mobile Payments SDK can authorize (sandbox + production). */
const MPSDK_COUNTRIES = new Set(["US", "CA", "GB", "AU"]);

/**
 * Mint credentials for the phone Mobile Payments SDK (authorize).
 * Returns access token + location — phone must not persist them beyond the session.
 * Validates the Square location country when the token can call Locations API.
 * Location lookup failures do not block minting — the SDK authorize result is authoritative.
 */
async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  const ctx = await staffFromEvent(event);
  const access = await getStoreSquareAccess(ctx.staff.store_id);
  if (!access.locationId) {
    return json(409, { error: "square_location_required" });
  }

  const applicationId = process.env.SQUARE_APPLICATION_ID || null;
  const envSandbox = (process.env.SQUARE_ENVIRONMENT || "sandbox").toLowerCase() !== "production";
  let locationName = access.locationName || null;
  let locationCountry = null;
  let locationStatus = null;
  let verificationError = null;
  let tokenSandbox = access.sandbox ?? envSandbox;

  try {
    const verified = await resolveSquareLocation(access.accessToken, access.locationId);
    const loc = verified.location;
    if (loc) {
      locationName = loc.name || locationName;
      locationCountry = loc.country || null;
      locationStatus = loc.status || null;
    }
    tokenSandbox = verified.sandbox;
    if (verified.flipped) {
      verificationError =
        `SQUARE_ENVIRONMENT is ${envSandbox ? "sandbox" : "production"} but this access token only works against ` +
        `${verified.sandbox ? "sandbox" : "production"}. Update Netlify SQUARE_ENVIRONMENT (and Application ID) to match.`;
    }
  } catch (err) {
    verificationError = squareHttpErrorMessage(err, access.locationId);
    // Soft-fail: still mint credentials so the phone can attempt SDK authorize.
    // Hard-fail only for clear country mismatches when we successfully read the location.
  }

  if (locationCountry && !MPSDK_COUNTRIES.has(locationCountry)) {
    return json(409, {
      error: "square_location_unsupported_country",
      message: `Square location ${access.locationId} is in ${locationCountry}. Mobile Payments SDK only supports US, CA, GB, AU. Pick a US sandbox location (Developer Console → Sandbox → Locations).`,
      locationId: access.locationId,
      locationName,
      locationCountry,
      applicationId,
      sandbox: tokenSandbox,
    });
  }

  // Sandbox Application IDs are sandbox-sq0idb-…; production are sq0idp-…
  if (applicationId) {
    const idIsSandbox = applicationId.startsWith("sandbox-");
    if (idIsSandbox !== Boolean(tokenSandbox)) {
      return json(409, {
        error: "square_app_id_environment_mismatch",
        message: `SQUARE_APPLICATION_ID looks ${idIsSandbox ? "sandbox" : "production"} but the access token is ${tokenSandbox ? "sandbox" : "production"}. Codemagic (IPA) and Netlify must use the same Square Application ID / environment.`,
        applicationId,
        sandbox: tokenSandbox,
        locationId: access.locationId,
        locationCountry,
        verificationError,
      });
    }
  }

  return json(200, {
    accessToken: access.accessToken,
    locationId: access.locationId,
    locationName,
    locationCountry,
    locationStatus,
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
