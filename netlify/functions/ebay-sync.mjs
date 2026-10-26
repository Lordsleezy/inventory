import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { pollAllStores, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { dispatchQueuedMigrationRequests } from "../lib/ebay-migrate.mjs";
import { dispatchQueuedPickupListRequests } from "../lib/ebay-pickup-list.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { wrapHandler, asNetlifyFunction, floorLog } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
import { syncEbayFees } from "../lib/ebay-fees.mjs";
import { sendInternalAlert, filterDeliverableEmails } from "../lib/mail.mjs";
import { EBAY_SYNC_LOCK_SECONDS, syncCompletedAt, syncNeedsStallEmail } from "../lib/ebay-sync-health.mjs";

const STORE_ID = "5487ca47-6147-4fe8-bc6d-46b6472726ba";

/**
 * Frequent and cheap: ingest eBay orders and end eBay listings for units that sold elsewhere.
 * Draft refresh, label quotes, repricing, category refresh, reconciliation and the spec backfill live in
 * ebay-drafts-refresh (every 15 minutes, locked, paced). This function never touches ebay_drafts.
 * Also dispatches any queued ebay_migration_request / ebay_pickup_list_request rows to background workers.
 */
async function handle(event) {
  if (ebayDisabled()) return json(200, { disabled: true });
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  try {
    const sb = serviceClient();
    // A run that is still going blocks the next one instead of piling on.
    const startedAt = Date.now();
    const result = await withLock("ebay-sync", EBAY_SYNC_LOCK_SECONDS, async () => {
      // Orders first. The offer scan and open delist tasks used to burn the whole
      // timeout, so the run was killed and the next fire only logged "already running".
      const orders = await pollAllStores();
      const polled = (orders || []).some((store) => (store.accounts || []).some((account) => !account.error));
      if (polled) {
        const storeIds = [...new Set(orders.map((store) => store.storeId).filter(Boolean))];
        await markEbaySyncCompleted(sb, storeIds.length ? storeIds : [STORE_ID]);
      }
      // Real eBay fees ride the order sync (no extra schedule). It makes no eBay calls unless an order is
      // still waiting on fees or the 6-hourly reconcile sweep is due, and it stops before the function timeout.
      let fees = [];
      if (polled) {
        const storeIds = [...new Set(orders.map((store) => store.storeId).filter(Boolean))];
        for (const storeId of storeIds.length ? storeIds : [STORE_ID]) {
          const budgetMs = 40000 - (Date.now() - startedAt);
          if (budgetMs < 5000) { fees.push({ storeId, skipped: "no_time_left" }); continue; }
          try {
            fees.push({ storeId, ...(await syncEbayFees(sb, storeId, { budgetMs: Math.min(budgetMs, 20000) })) });
          } catch (err) {
            fees.push({ storeId, error: err instanceof Error ? err.message : String(err) });
            await floorLog({ storeId, level: "error", event: "ebay.fees_sync_failed", message: err instanceof Error ? err.message : String(err) });
          }
        }
      }
      let migrationDispatch = [];
      let pickupListDispatch = [];
      try {
        migrationDispatch = await dispatchQueuedMigrationRequests();
      } catch (err) {
        migrationDispatch = [{ ok: false, error: err instanceof Error ? err.message : String(err) }];
      }
      try {
        pickupListDispatch = await dispatchQueuedPickupListRequests();
      } catch (err) {
        pickupListDispatch = [{ ok: false, error: err instanceof Error ? err.message : String(err) }];
      }
      const withdrawn = await withdrawOpenEbayTasks();
      return { withdrawn, orders, fees, migrationDispatch, pickupListDispatch, completed: polled };
    }, sb);
    if (result?.skipped || result?.completed === false) await emailIfSyncStalled(sb);
    return json(200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { await emailIfSyncStalled(serviceClient()); } catch { /* stall mail must not hide the sync error */ }
    return json(500, { error: message });
  }
}

async function markEbaySyncCompleted(sb, storeIds) {
  const value = new Date().toISOString();
  for (const store_id of storeIds) {
    const { error } = await sb.from("store_settings").upsert(
      { store_id, key: "ebay_sync_completed_at", value },
      { onConflict: "store_id,key" },
    );
    if (error) throw new Error(error.message);
  }
}

async function emailIfSyncStalled(sb) {
  const { data, error } = await sb
    .from("store_settings")
    .select("key,value")
    .eq("store_id", STORE_ID)
    .in("key", ["ebay_sync_completed_at", "ebay_last_sync_at", "ebay_sync_stall_alerted_at", "order_notify_emails"]);
  if (error) return;
  const rows = data || [];
  const completedAt = syncCompletedAt(rows);
  const alertedRaw = rows.find((row) => row.key === "ebay_sync_stall_alerted_at")?.value;
  const alertedAt = Date.parse(typeof alertedRaw === "string" ? alertedRaw : "");
  if (!syncNeedsStallEmail({ completedAt, alertedAt: Number.isFinite(alertedAt) ? alertedAt : null })) return;
  const cfg = rows.find((row) => row.key === "order_notify_emails")?.value;
  const to = filterDeliverableEmails(Array.isArray(cfg) && cfg.length ? cfg : ["pgg124@gmail.com", "obitracking@gmail.com"]);
  const when = completedAt ? new Date(completedAt).toISOString() : "never";
  let sent;
  try {
    sent = await sendInternalAlert({
      to,
      subject: "eBay sync has not finished in 30 minutes",
      text: `eBay order sync has not completed since ${when}.\nNew eBay sales are not being recorded until a run finishes.\nIf a run is killed, its lock expires on its own after 10 minutes.`,
    });
  } catch (err) {
    await floorLog({
      storeId: STORE_ID,
      level: "error",
      event: "ebay.sync_stalled",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (sent?.skipped) return;
  await sb.from("store_settings").upsert(
    { store_id: STORE_ID, key: "ebay_sync_stall_alerted_at", value: new Date().toISOString() },
    { onConflict: "store_id,key" },
  );
  await floorLog({ storeId: STORE_ID, level: "warn", event: "ebay.sync_stalled", message: `last completion ${when}` });
}

export const invoke = wrapHandler("ebay-sync", handle);

export default asNetlifyFunction(invoke);
