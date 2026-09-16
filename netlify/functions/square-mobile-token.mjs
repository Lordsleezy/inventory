import { staffFromEvent, serviceClient, decryptSecret, json, corsHeaders } from "../lib/server.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const { staff } = await staffFromEvent(event);
    const sb = serviceClient();
    const { data, error } = await sb
      .from("connections")
      .select("token_ciphertext, location_id, status, expires_at")
      .eq("store_id", staff.store_id)
      .eq("provider", "square")
      .maybeSingle();
    if (error || !data || data.status !== "connected" || !data.token_ciphertext) {
      return json(409, { error: "square_not_connected" });
    }
    if (!data.location_id) return json(409, { error: "pick_location" });
    const accessToken = decryptSecret(data.token_ciphertext);
    return json(200, {
      accessToken,
      locationId: data.location_id,
      expiresAt: data.expires_at,
    });
  } catch (err) {
    return json(401, { error: err instanceof Error ? err.message : String(err) });
  }
}
