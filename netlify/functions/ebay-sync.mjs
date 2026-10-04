import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { pollAllStores, reconcileListedOffers, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { syncDrafts } from "../lib/ebay-drafts.mjs";
import { resumeBackfillIfStale, startBackfill, backfillStatus } from "../lib/ebay-backfill.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const sb = serviceClient();
    // Draft pricing must still advance if a marketplace poll fails later.
    // EMERGENCY GATE: draft refresh/quotes/reprice and the spec backfill are paused unless EBAY_BACKGROUND_WORK=on.
    const heavy = process.env.EBAY_BACKGROUND_WORK === "on";
    const { data: allStores } = heavy ? await sb.from("stores").select("id") : { data: [] };
    const drafted = [];
    for (const row of allStores ?? []) {
      try {
        drafted.push({ storeId: row.id, ...(await syncDrafts(row.id, { quoteLimit: 8 })) });
        const backfill = await backfillStatus(row.id);
        if (backfill.status === "idle") await startBackfill(row.id);
        else await resumeBackfillIfStale(row.id);
      } catch (err) {
        drafted.push({ storeId: row.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const withdrawn = await withdrawOpenEbayTasks();
    const { data: stores } = await sb.from("connections").select("store_id").eq("provider", "ebay").eq("status", "connected");
    const reconciled = [];
    for (const row of stores ?? []) {
      reconciled.push({ storeId: row.store_id, listings: await reconcileListedOffers(row.store_id) });
    }
    const orders = await pollAllStores();
    return json(200, { withdrawn, reconciled, orders, drafted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message });
  }
}

export const handler = wrapHandler("ebay-sync", handle);
