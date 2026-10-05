import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { pollAllStores, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { withLock } from "../lib/bg-guard.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";
import { ebayDisabled } from "../lib/ebay-env.mjs";

/**
 * Frequent and cheap: ingest eBay orders and end eBay listings for units that sold elsewhere.
 * Draft refresh, label quotes, repricing, category refresh, reconciliation and the spec backfill live in
 * ebay-drafts-refresh (every 15 minutes, locked, paced). This function never touches ebay_drafts.
 */
async function handle(event) {
  if (ebayDisabled()) return json(200, { disabled: true });
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const sb = serviceClient();
    // A run that is still going blocks the next one instead of piling on.
    const result = await withLock("ebay-sync", 100, async () => {
      const withdrawn = await withdrawOpenEbayTasks();
      const orders = await pollAllStores();
      return { withdrawn, orders };
    }, sb);
    return json(200, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message });
  }
}

export const handler = wrapHandler("ebay-sync", handle);
