import { staffFromEvent, json, corsHeaders } from "../lib/server.mjs";
import { serviceClient } from "../lib/server.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "GET") return json(405, { error: "get_only" });
  try {
    const { staff } = await staffFromEvent(event);
    const params = event.queryStringParameters || {};
    const sb = serviceClient();
    let q = sb
      .from("floor_logs")
      .select("id, created_at, store_id, sku, trace_id, source, level, event, message, detail")
      .eq("store_id", staff.store_id)
      .order("created_at", { ascending: false })
      .limit(Math.min(200, Number(params.limit) || 80));
    if (params.sku) q = q.eq("sku", String(params.sku));
    if (params.traceId) q = q.eq("trace_id", String(params.traceId));
    if (params.source) q = q.eq("source", String(params.source));
    if (params.level) q = q.eq("level", String(params.level));
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return json(200, { ok: true, logs: data || [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message === "not_signed_in" || message === "not_staff" ? 401 : 400;
    return json(code, { error: "floor_logs_failed", message });
  }
}
