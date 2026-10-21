/**
 * Long-running manual eBay order sync (all accounts or one).
 * Netlify background function: up to ~15 minutes — avoids portal 504s.
 */
import { requireEnv } from "../lib/server.mjs";
import { asNetlifyFunction, floorLog, runTrace } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
import { runEbaySyncNow, SYNC_NOW_KEY } from "../lib/ebay-sync-now.mjs";

export const invoke = async (event) => {
  if (ebayDisabled()) return { statusCode: 202, body: "disabled" };
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const body = JSON.parse(event.body || "{}");
  const storeId = body.store_id;
  if (!storeId) return { statusCode: 400, body: "store_id_required" };
  const accountId = body.account_id || body.accountId || null;

  await runTrace({ source: "ebay-sync-now", storeId }, async () => {
    try {
      const result = await runEbaySyncNow(storeId, {
        accountId,
        requestedBy: body.requested_by || "ebay-sync-now-background",
      });
      await floorLog({
        storeId,
        event: "ebay.sync_now.done",
        message: result?.progress?.message || "sync finished",
        detail: { summary: result?.summary, status: result?.status },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await floorLog({
        storeId,
        level: "error",
        event: "ebay.sync_now.crash",
        message,
        detail: { stack: String(err?.stack || "").slice(0, 3000) },
      });
      try {
        const { serviceClient } = await import("../lib/server.mjs");
        const sb = serviceClient();
        await sb.from("store_settings").upsert(
          {
            store_id: storeId,
            key: SYNC_NOW_KEY,
            value: {
              status: "error",
              error: message.slice(0, 500),
              finished_at: new Date().toISOString(),
              progress: { phase: "error", message },
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
