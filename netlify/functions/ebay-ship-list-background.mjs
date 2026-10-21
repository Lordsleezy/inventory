/**
 * Background worker: list queued SKUs on the selling account with
 * calculated shipping (buyer pays) + local pickup.
 * Auth: Bearer SUPABASE_SERVICE_ROLE (same as ebay-pickup-list-background).
 */
import { requireEnv } from "../lib/server.mjs";
import { asNetlifyFunction, floorLog, runTrace } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
import { runShipListJob } from "../lib/ebay-ship-list.mjs";

export const invoke = async (event) => {
  if (ebayDisabled()) return { statusCode: 202, body: "disabled" };
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const body = JSON.parse(event.body || "{}");
  const storeId = body.store_id;
  if (!storeId) return { statusCode: 400, body: "store_id_required" };
  await runTrace({ source: "ebay-ship-list", storeId }, async () => {
    try {
      const result = await runShipListJob(storeId, {
        createdBy: body.created_by || "ebay-ship-list-background",
      });
      await floorLog({
        storeId,
        event: "ebay.ship_list.done",
        message: "ship list finished",
        detail: {
          status: result.status,
          ok_count: result.ok_count,
          fail_count: result.fail_count,
          skip_count: result.skip_count,
          ship_policy: result.ship_policy,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await floorLog({
        storeId,
        level: "error",
        event: "ebay.ship_list.crash",
        message,
        detail: { stack: String(err?.stack || "").slice(0, 3000) },
      });
    }
  });
  return { statusCode: 202 };
};

export default asNetlifyFunction(invoke);
