/**
 * Paced bulk publish (and future migrate batches) for the listing manager.
 * Netlify background: up to ~15 minutes.
 */
import { requireEnv } from "../lib/server.mjs";
import { asNetlifyFunction, floorLog, runTrace } from "../lib/floor-log.mjs";
import { runBulkPublish } from "../lib/listing-manager.mjs";

export const invoke = async (event) => {
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const body = JSON.parse(event.body || "{}");
  const storeId = body.store_id;
  if (!storeId) return { statusCode: 400, body: "store_id_required" };
  const job = String(body.job || "bulk_publish");

  await runTrace({ source: "listing-manager-bg", storeId }, async () => {
    try {
      if (job === "bulk_publish") {
        const result = await runBulkPublish(storeId, {
          channel: body.channel,
          skus: body.skus || [],
        });
        await floorLog({
          storeId,
          event: "listing_manager.bulk_publish.done",
          message: result?.progress?.message || "bulk done",
          detail: { summary: result?.summary, channel: body.channel },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await floorLog({
        storeId,
        level: "error",
        event: "listing_manager.bg.crash",
        message,
        detail: { job, stack: String(err?.stack || "").slice(0, 3000) },
      });
    }
  });
  return { statusCode: 202 };
};

export default asNetlifyFunction(invoke);
