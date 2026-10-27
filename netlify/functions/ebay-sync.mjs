import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { pollAllStores, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { dispatchQueuedMigrationRequests } from "../lib/ebay-migrate.mjs";
import { dispatchQueuedPickupListRequests } from "../lib/ebay-pickup-list.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { wrapHandler, asNetlifyFunction, floorLog } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";
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
    const result = await withLock("ebay-sync", EBAY_SYNC_LOCK_SECONDS, async () => {
      // Orders first. The offer scan and open delist tasks used to burn the whole
      // timeout, so the run was killed and the next fire only logged "already running".
      const orders = await pollAllStores();
      const polled = (orders || []).some((store) => (store.accounts || []).some((account) => !account.error));
      if (polled) {
        const storeIds = [...new Set(orders.map((store) => store.storeId).filter(Boolean))];
        await markEbaySyncCompleted(sb, storeIds.length ? storeIds : [STORE_ID]);
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
      // eBay / Square payouts to the bank become withdrawals; self-throttled to once per 6 hours, so most runs only read one setting.
      let payouts = null;
      try { payouts = await (await import("../lib/payout-import-live.mjs")).runPayoutImport(sb, STORE_ID); }
      catch (err) { payouts = { error: err instanceof Error ? err.message : String(err) }; }
      return { withdrawn, orders, migrationDispatch, pickupListDispatch, payouts, completed: polled };
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
