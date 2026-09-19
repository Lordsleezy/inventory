import { staffFromEvent, json, corsHeaders } from "../lib/server.mjs";
import { listSku } from "../lib/ebay.mjs";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "post_only" });
  try {
    const { staff } = await staffFromEvent(event);
    const body = JSON.parse(event.body || "{}");
    const skus = Array.isArray(body.skus) ? body.skus : body.sku ? [body.sku] : [];
    if (!skus.length) return json(400, { error: "sku_required" });
    const results = [];
    for (const sku of skus) {
      results.push(await listSku(staff.store_id, String(sku)));
    }
    return json(200, { ok: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err && err.code === "ebay_not_connected" ? 409 : 400;
    console.log(
      "ebay-list",
      JSON.stringify({
        error: message,
        status: err?.status || null,
        ebay: err?.body || null,
      }),
    );
    return json(code, {
      error: message === "ebay_not_connected" ? "ebay_not_connected" : "ebay_list_failed",
      message,
      ebay: err?.body || null,
    });
  }
}
