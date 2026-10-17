import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { pollAllStores, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { dispatchQueuedMigrationRequests } from "../lib/ebay-migrate.mjs";
import { dispatchQueuedPickupListRequests } from "../lib/ebay-pickup-list.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";

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
    const result = await withLock("ebay-sync", 100, async () => {
      // Dispatch queued migrations / pickup lists FIRST — withdrawOpenEbayTasks can burn the 30s
      // timeout on Inventory offer 404s and never reach the queue otherwise.
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
      const orders = await pollAllStores();
      return { withdrawn, orders, migrationDispatch, pickupListDispatch };
    }, sb);
    return json(200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message });
  }
}

export const invoke = wrapHandler("ebay-sync", handle);

export default asNetlifyFunction(invoke);
