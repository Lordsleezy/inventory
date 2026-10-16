/**
 * Lightweight cron: claim queued ebay_migration_request rows and start
 * ebay-migrate-background. Kept separate from ebay-sync so Inventory offer
 * 404 noise cannot burn the timeout before dispatch runs.
 */
import { json, corsHeaders } from "../lib/server.mjs";
import { dispatchQueuedMigrationRequests } from "../lib/ebay-migrate.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";

async function handle(event) {
  if (ebayDisabled()) return json(200, { disabled: true });
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  try {
    const migrationDispatch = await dispatchQueuedMigrationRequests();
    return json(200, { ok: true, migrationDispatch });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message });
  }
}

export const invoke = wrapHandler("ebay-migrate-dispatch", handle);

export default asNetlifyFunction(invoke);
