import { ownerFromEvent, serviceClient, decryptSecret, json, corsHeaders } from "../lib/server.mjs";
import { getStoreSquareAccess } from "../lib/square.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const { staff } = await ownerFromEvent(event);
    let token;
    try {
      const access = await getStoreSquareAccess(staff.store_id);
      token = access.accessToken;
    } catch {
      const sb = serviceClient();
      const { data, error } = await sb
        .from("connections")
        .select("token_ciphertext, status")
        .eq("store_id", staff.store_id)
        .eq("provider", "square")
        .maybeSingle();
      if (error || !data?.token_ciphertext || data.status !== "connected") {
        return json(409, { error: "square_not_connected" });
      }
      token = decryptSecret(data.token_ciphertext);
    }
    const host =
      (process.env.SQUARE_ENVIRONMENT || process.env.SQUARE_ENV || "sandbox") === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";
    const res = await fetch(`${host}/v2/locations`, {
      headers: { Authorization: `Bearer ${token}`, "Square-Version": "2024-01-18" },
    });
    const body = await res.json();
    if (!res.ok) return json(res.status, { error: body.message || body.errors?.[0]?.detail || "locations_failed", body });
    return json(200, {
      locations: (body.locations || []).map((l) => ({ id: l.id, name: l.name, status: l.status })),
    });
  } catch (err) {
    return json(401, { error: err instanceof Error ? err.message : String(err) });
  }
}

export const handler = wrapHandler("square-locations", handle);
