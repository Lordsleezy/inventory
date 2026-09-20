import { json, corsHeaders, staffFromEvent } from "../lib/server.mjs";
import { getStoreSquareAccess, squareClient } from "../lib/square.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

/** List Square locations for the connected store (or sandbox test token). */
async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  const ctx = await staffFromEvent(event);
  const access = await getStoreSquareAccess(ctx.staff.store_id);
  const client = squareClient(access.accessToken);
  const { result } = await client.locationsApi.listLocations();
  const locations = (result.locations || []).map((l) => ({
    id: l.id,
    name: l.name,
    status: l.status,
  }));
  return json(200, { locations, current_location_id: access.locationId, source: access.source });
}

export const handler = wrapHandler("square-list-locations", async (event) => {
  try {
    return await handle(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "square_not_connected") return json(409, { error: msg });
    throw err;
  }
});
