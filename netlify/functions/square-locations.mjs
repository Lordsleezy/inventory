import { ownerFromEvent, serviceClient, decryptSecret, json, corsHeaders, requireEnv } from "../lib/server.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const { staff } = await ownerFromEvent(event);
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
    const token = decryptSecret(data.token_ciphertext);
    const host =
      process.env.SQUARE_ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
    const res = await fetch(`${host}/v2/locations`, {
      headers: { Authorization: `Bearer ${token}`, "Square-Version": "2024-01-18" },
    });
    const body = await res.json();
    if (!res.ok) return json(res.status, body);
    return json(200, {
      locations: (body.locations || []).map((l) => ({ id: l.id, name: l.name, status: l.status })),
    });
  } catch (err) {
    return json(401, { error: err instanceof Error ? err.message : String(err) });
  }
}
