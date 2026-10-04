/**
 * Low-priority eBay draft maintenance. One run at a time (lock), small paced batches, stops when the
 * database is busy so the register, website, phone app and admin portal always win.
 * It never publishes, ends or reprices a live eBay listing; it only refreshes Floor's own draft rows.
 */
import { requireEnv, serviceClient } from "../lib/server.mjs";
import { reconcileListedOffers } from "../lib/ebay.mjs";
import { syncDrafts } from "../lib/ebay-drafts.mjs";
import { backfillStatus, runBackfill, startBackfill } from "../lib/ebay-backfill.mjs";
import { dbBusy, sleep, withLock } from "../lib/bg-guard.mjs";

const QUOTE_BATCH = Number(process.env.EBAY_QUOTE_BATCH) || 10;
const BACKFILL_BATCH = Number(process.env.EBAY_BACKFILL_BATCH) || 5;
const LOG_DAYS = 14;

export async function refreshOnce(sb = serviceClient()) {
  const out = { stores: [], skipped: null };
  const { data: stores } = await sb.from("stores").select("id");
  for (const row of stores ?? []) {
    if (await dbBusy(sb)) { out.skipped = "database busy"; break; }
    const entry = { storeId: row.id };
    try {
      const { data: conn } = await sb.from("connections").select("store_id").eq("store_id", row.id).eq("provider", "ebay").eq("status", "connected").maybeSingle();
      if (conn) entry.reconciled = await reconcileListedOffers(row.id);
      await sleep(500);
      entry.drafts = await syncDrafts(row.id, { quoteLimit: QUOTE_BATCH, pace: true });
      await sleep(500);
      if (!(await dbBusy(sb))) {
        const status = await backfillStatus(row.id);
        if (status.status === "idle") await startBackfill(row.id);
        if (status.status === "idle" || status.status === "running") {
          entry.backfill = await runBackfill(row.id, { maxUnits: BACKFILL_BATCH, pauseMs: 2000, busy: () => dbBusy(sb), maxMs: 8 * 60 * 1000 })
            .then((job) => ({ status: job?.status, processed: job?.processed, total: job?.total }));
        }
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
    }
    out.stores.push(entry);
  }
  // Keep the diagnostic log small.
  await sb.from("floor_logs").delete().lt("created_at", new Date(Date.now() - LOG_DAYS * 86400_000).toISOString());
  return out;
}

export const handler = async (event) => {
  const header = event.headers?.authorization || event.headers?.Authorization || "";
  if (header !== `Bearer ${requireEnv("SUPABASE_SERVICE_ROLE")}`) return { statusCode: 401, body: "unauthorized" };
  if (process.env.EBAY_BACKGROUND_WORK !== "on") return { statusCode: 202, body: "paused" };
  const result = await withLock("ebay-drafts-refresh", 13 * 60, () => refreshOnce());
  console.info("ebay_drafts_refresh", JSON.stringify(result).slice(0, 2000));
  return { statusCode: 202 };
};
