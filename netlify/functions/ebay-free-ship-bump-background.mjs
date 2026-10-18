/**
 * Background: +$10 / free shipping bump, or collectible revert (−$10 + calculated ship).
 */
import { requireEnv } from "../lib/server.mjs";
import { asNetlifyFunction, floorLog, runTrace } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
import { runFreeShipBump, runCollectibleBumpRevert } from "../lib/ebay-free-ship-bump.mjs";

export const invoke = async (event) => {
  if (ebayDisabled()) return { statusCode: 202, body: "disabled" };
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const body = JSON.parse(event.body || "{}");
  const storeId = body.store_id;
  if (!storeId) return { statusCode: 400, body: "store_id_required" };
  const action = body.action === "revert_collectibles" ? "revert_collectibles" : "bump";

  await runTrace({ source: "ebay-free-ship-bump", storeId, action }, async () => {
    try {
      const result =
        action === "revert_collectibles"
          ? await runCollectibleBumpRevert(storeId)
          : await runFreeShipBump(storeId);
      await floorLog({
        storeId,
        event: action === "revert_collectibles" ? "ebay.free_ship_bump.revert_done" : "ebay.free_ship_bump.done",
        message:
          action === "revert_collectibles"
            ? `reverted ${result.summary?.reverted || 0}/${result.summary?.targets || 0} collectibles`
            : `updated ${result.summary?.updated || 0}/${result.summary?.eligible || 0}`,
        detail: { summary: result.summary, action },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const requestKey =
        action === "revert_collectibles"
          ? "ebay_free_ship_bump_revert_request"
          : "ebay_free_ship_bump_request";
      await floorLog({
        storeId,
        level: "error",
        event: "ebay.free_ship_bump.crash",
        message,
        detail: { stack: String(err?.stack || "").slice(0, 3000), action },
      });
      try {
        const { serviceClient } = await import("../lib/server.mjs");
        const sb = serviceClient();
        await sb.from("store_settings").upsert(
          {
            store_id: storeId,
            key: requestKey,
            value: {
              status: "error",
              error: message.slice(0, 500),
              finished_at: new Date().toISOString(),
              action,
            },
          },
          { onConflict: "store_id,key" },
        );
      } catch {
        /* best-effort */
      }
    }
  });
  return { statusCode: 202 };
};

export default asNetlifyFunction(invoke);
