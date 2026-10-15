/**
 * Long-running eBay account migration (end on source → create on dest, paced).
 * Netlify background function: up to ~15 minutes.
 */
import { requireEnv } from "../lib/server.mjs";
import { asNetlifyFunction, floorLog, runTrace } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
import { runEbayMigration } from "../lib/ebay-migrate.mjs";

export const invoke = async (event) => {
  if (ebayDisabled()) return { statusCode: 202, body: "disabled" };
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) {
    return { statusCode: 401, body: "unauthorized" };
  }
  const body = JSON.parse(event.body || "{}");
  const storeId = body.store_id;
  if (!storeId) return { statusCode: 400, body: "store_id_required" };
  const mode = body.mode === "live" ? "live" : "dry_run";
  await runTrace({ source: "ebay-migrate", storeId }, async () => {
    try {
      const result = await runEbayMigration(storeId, {
        mode,
        createdBy: body.created_by || "ebay-migrate-background",
        limit: body.limit != null ? Number(body.limit) : null,
      });
      await floorLog({
        storeId,
        event: "ebay.migrate.done",
        message: `${mode} finished`,
        detail: {
          ok: result.ok,
          summary: result.summary,
          runId: result.runId,
          blockers: result.blockers,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await floorLog({
        storeId,
        level: "error",
        event: "ebay.migrate.crash",
        message,
        detail: { stack: String(err?.stack || "").slice(0, 3000) },
      });
    }
  });
  return { statusCode: 202 };
};

export default asNetlifyFunction(invoke);
