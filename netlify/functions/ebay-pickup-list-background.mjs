/**
 * Background worker: list queued SKUs on the selling account as LOCAL PICKUP ONLY.
 * Auth: Bearer SUPABASE_SERVICE_ROLE (same as ebay-migrate-background).
 */
import { requireEnv } from "../lib/server.mjs";
import { asNetlifyFunction, floorLog, runTrace } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
import { runPickupListJob } from "../lib/ebay-pickup-list.mjs";

export const invoke = async (event) => {
  if (ebayDisabled()) return { statusCode: 202, body: "disabled" };
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const body = JSON.parse(event.body || "{}");
  const storeId = body.store_id;
  if (!storeId) return { statusCode: 400, body: "store_id_required" };
  await runTrace({ source: "ebay-pickup-list", storeId }, async () => {
    try {
      const result = await runPickupListJob(storeId, {
        createdBy: body.created_by || "ebay-pickup-list-background",
      });
      await floorLog({
        storeId,
        event: "ebay.pickup_list.done",
        message: "pickup list finished",
        detail: {
          status: result.status,
          ok_count: result.ok_count,
          fail_count: result.fail_count,
          skip_count: result.skip_count,
          pickup_policy: result.pickup_policy,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await floorLog({
        storeId,
        level: "error",
        event: "ebay.pickup_list.crash",
        message,
        detail: { stack: String(err?.stack || "").slice(0, 3000) },
      });
    }
  });
  return { statusCode: 202 };
};

export default asNetlifyFunction(invoke);
