/**
 * Lightweight cron: claim queued ebay_migration_request / ebay_pickup_list_request
 * rows and start background workers. Kept separate from ebay-sync so Inventory offer
 * 404 noise cannot burn the timeout before dispatch runs.
 */
import { json, corsHeaders } from "../lib/server.mjs";
import { dispatchQueuedMigrationRequests } from "../lib/ebay-migrate.mjs";
import { dispatchQueuedPickupListRequests } from "../lib/ebay-pickup-list.mjs";
import { dispatchQueuedEbayListingAudits } from "../lib/ebay-listing-audit.mjs";
import { dispatchQueuedFreeShipBumps } from "../lib/ebay-free-ship-bump.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";

async function handle(event) {
  if (ebayDisabled()) return json(200, { disabled: true });
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  try {
    const migrationDispatch = await dispatchQueuedMigrationRequests();
    const pickupListDispatch = await dispatchQueuedPickupListRequests();
    const listingAuditDispatch = await dispatchQueuedEbayListingAudits();
    const freeShipBumpDispatch = await dispatchQueuedFreeShipBumps();
    return json(200, {
      ok: true,
      migrationDispatch,
      pickupListDispatch,
      listingAuditDispatch,
      freeShipBumpDispatch,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message });
  }
}

export const invoke = wrapHandler("ebay-migrate-dispatch", handle);

export default asNetlifyFunction(invoke);
