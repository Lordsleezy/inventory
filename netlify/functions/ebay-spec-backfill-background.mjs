import { requireEnv } from "../lib/server.mjs";
import { runBackfill } from "../lib/ebay-backfill.mjs";

export async function handler(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const body = JSON.parse(event.body || "{}");
  if (!body.storeId) return { statusCode: 400, body: "store_required" };
  await runBackfill(body.storeId);
  return { statusCode: 200, body: "" };
}
