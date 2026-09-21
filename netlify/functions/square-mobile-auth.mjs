import { json, corsHeaders, staffFromEvent } from "../lib/server.mjs";
import { getStoreSquareAccess, squareClient } from "../lib/square.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

/** Countries where Mobile Payments SDK can authorize (sandbox + production). */
const MPSDK_COUNTRIES = new Set(["US", "CA", "GB", "AU"]);

/**
 * Mint credentials for the phone Mobile Payments SDK (authorize).
 * Returns access token + location — phone must not persist them beyond the session.
 * Validates the Square location country and that Application ID matches the token environment.
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

  try {
    const client = squareClient(access.accessToken);
    const { result } = await client.locationsApi.retrieveLocation(access.locationId);
    const loc = result.location;
    if (loc) {
      locationName = loc.name || locationName;
      locationCountry = loc.country || null;
      locationStatus = loc.status || null;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json(502, {
      error: "square_location_lookup_failed",
      message: `Could not verify Square location ${access.locationId}: ${msg}`,
      locationId: access.locationId,
      applicationId,
      sandbox: access.sandbox ?? envSandbox,
    });
  }

  if (locationCountry && !MPSDK_COUNTRIES.has(locationCountry)) {
    return json(409, {
      error: "square_location_unsupported_country",
      message: `Square location ${access.locationId} is in ${locationCountry}. Mobile Payments SDK only supports US, CA, GB, AU. Pick a US sandbox location (Developer Console → Sandbox → Locations).`,
      locationId: access.locationId,
      locationName,
      locationCountry,
      applicationId,
      sandbox: access.sandbox ?? envSandbox,
    });
  }

  // Sandbox Application IDs are sandbox-sq0idb-…; production are sq0idp-…
  if (applicationId) {
    const idIsSandbox = applicationId.startsWith("sandbox-");
    const tokenSandbox = access.sandbox ?? envSandbox;
    if (idIsSandbox !== Boolean(tokenSandbox)) {
      return json(409, {
        error: "square_app_id_environment_mismatch",
        message: `SQUARE_APPLICATION_ID looks ${idIsSandbox ? "sandbox" : "production"} but the access token is ${tokenSandbox ? "sandbox" : "production"}. Codemagic (IPA) and Netlify must use the same Square Application ID / environment.`,
        applicationId,
        sandbox: tokenSandbox,
        locationId: access.locationId,
        locationCountry,
      });
    }
  }

  return json(200, {
    accessToken: access.accessToken,
    locationId: access.locationId,
    locationName,
    locationCountry,
    locationStatus,
    sandbox: access.sandbox ?? envSandbox,
    applicationId,
    source: access.source || null,
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
