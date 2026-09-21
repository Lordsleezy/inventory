import { json, corsHeaders, staffFromEvent } from "../lib/server.mjs";
import { getStoreSquareAccess } from "../lib/square.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

/**
 * Mint credentials for the phone Mobile Payments SDK (authorize).
 * Returns access token + location — phone must not persist them beyond the session.
 */
async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  const ctx = await staffFromEvent(event);
  const access = await getStoreSquareAccess(ctx.staff.store_id);
  if (!access.locationId) {
    return json(409, { error: "square_location_required" });
  }
  return json(200, {
    accessToken: access.accessToken,
    locationId: access.locationId,
    locationName: access.locationName || null,
    sandbox: access.sandbox,
    applicationId: process.env.SQUARE_APPLICATION_ID || null,
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
