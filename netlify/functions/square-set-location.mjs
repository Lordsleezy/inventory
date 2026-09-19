import { ownerFromEvent, serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "POST" });
  try {
    const { staff } = await ownerFromEvent(event);
    const body = JSON.parse(event.body || "{}");
    const sb = serviceClient();
    const { error } = await sb
      .from("connections")
      .update({
        location_id: body.locationId,
        account_label: body.name || null,
        updated_at: new Date().toISOString(),
      })
      .eq("store_id", staff.store_id)
      .eq("provider", "square");
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  } catch (err) {
    return json(401, { error: err instanceof Error ? err.message : String(err) });
  }
}

export const handler = wrapHandler("square-set-location", handle);
