/**
 * Background: list today's first-photo units with free-ship bake-in (+10% fees)
 * or calculated shipping when free would exceed retail.
 */
import { requireEnv } from "../lib/server.mjs";
import { asNetlifyFunction, floorLog, runTrace } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
import { runPhotoDayList } from "../lib/ebay-photo-day-list.mjs";

export const invoke = async (event) => {
  if (ebayDisabled()) return { statusCode: 202, body: "disabled" };
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const body = JSON.parse(event.body || "{}");
  const storeId = body.store_id;
  if (!storeId) return { statusCode: 400, body: "store_id_required" };

  await runTrace({ source: "ebay-photo-day-list", storeId }, async () => {
    try {
      const result = await runPhotoDayList(storeId);
      await floorLog({
        storeId,
        event: "ebay.photo_day_list.done",
        message: `listed ${result.summary?.listed || 0}/${result.summary?.targets || 0}`,
        detail: { summary: result.summary },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await floorLog({
        storeId,
        level: "error",
        event: "ebay.photo_day_list.crash",
        message,
        detail: { stack: String(err?.stack || "").slice(0, 3000) },
      });
      try {
        const { serviceClient } = await import("../lib/server.mjs");
        const sb = serviceClient();
        await sb.from("store_settings").upsert(
          {
            store_id: storeId,
            key: "ebay_photo_day_list_request",
            value: {
              status: "error",
              error: message.slice(0, 500),
              finished_at: new Date().toISOString(),
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
