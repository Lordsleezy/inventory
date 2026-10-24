import { json, requireEnv } from "../lib/server.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { syncChannelTaxonomy } from "../lib/category-taxonomy.mjs";
import { STORE_DEFAULT } from "../lib/amazon.mjs";

async function handle(event) {
  if (event.httpMethod !== "POST" || event.headers?.authorization !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`)
    return json(403, { error: "forbidden" });
  const body = JSON.parse(event.body || "{}");
  const channel = String(body.channel || "");
  if (!["ebay", "amazon", "tiktok"].includes(channel)) return json(400, { error: "invalid_channel" });
  try {
    const result = await syncChannelTaxonomy(channel, body.store_id || STORE_DEFAULT);
    return json(200, { ok: true, ...result });
  } catch (error) {
    return json(500, { ok: false, channel, error: String(error) });
  }
}

export const invoke = wrapHandler("category-sync-background", handle);
export default asNetlifyFunction(invoke);
