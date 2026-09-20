import { json, corsHeaders, staffFromEvent, serviceClient } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

/** Persist Square location_id for the store (no tokens involved). */
async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  const ctx = await staffFromEvent(event);
  if (ctx.staff.role !== "owner" && ctx.staff.role !== "manager") {
    return json(403, { error: "not_manager" });
  }
  const body = JSON.parse(event.body || "{}");
  const locationId = String(body.locationId || "").trim();
  const locationName = body.locationName ? String(body.locationName) : null;
  if (!locationId) return json(400, { error: "location_required" });

  const sb = serviceClient();
  const { data: row } = await sb.from("square_connections").select("store_id").eq("store_id", ctx.staff.store_id).maybeSingle();
  if (!row) return json(409, { error: "square_not_connected" });

  await sb
    .from("square_connections")
    .update({
      location_id: locationId,
      location_name: locationName,
      updated_at: new Date().toISOString(),
    })
    .eq("store_id", ctx.staff.store_id);

  await sb.from("store_settings").upsert({
    store_id: ctx.staff.store_id,
    key: "card_payments_enabled",
    value: true,
  });

  return json(200, { ok: true, location_id: locationId });
}

export const handler = wrapHandler("square-set-store-location", handle);
