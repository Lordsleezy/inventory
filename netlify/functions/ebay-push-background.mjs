/** Runs queued eBay pushes (up to 15 minutes, so a slow eBay or database cannot silently kill them). */
import { requireEnv } from "../lib/server.mjs";
import { runTrace, floorLog } from "../lib/floor-log.mjs";
import { markPushFailed, runPushQueue } from "../lib/ebay-drafts.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";

export const handler = async (event) => {
  if (ebayDisabled()) return { statusCode: 202, body: "disabled" };
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) return { statusCode: 401, body: "unauthorized" };
  const body = JSON.parse(event.body || "{}");
  const skus = Array.isArray(body.skus) ? body.skus.map(String).slice(0, 25) : [];
  if (!body.store_id || !skus.length) return { statusCode: 400, body: "store_id_and_skus_required" };
  await runTrace({ source: "ebay-push", storeId: body.store_id }, async () => {
    try {
      await runPushQueue(body.store_id, skus);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await floorLog({ level: "error", event: "ebay.push.crash", message, detail: { skus, stack: String(err?.stack || "").slice(0, 3000) } });
      await markPushFailed(body.store_id, skus, `The push worker crashed: ${message}`).catch(() => undefined);
    }
  });
  return { statusCode: 202 };
};
