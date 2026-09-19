import { json, corsHeaders, serviceClient } from "../lib/server.mjs";
import { pollAllStores, reconcileListedOffers, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const withdrawn = await withdrawOpenEbayTasks();
    const sb = serviceClient();
    const { data: stores } = await sb.from("connections").select("store_id").eq("provider", "ebay").eq("status", "connected");
    const reconciled = [];
    for (const row of stores ?? []) {
      reconciled.push({ storeId: row.store_id, listings: await reconcileListedOffers(row.store_id) });
    }
    const orders = await pollAllStores();
    return json(200, { withdrawn, reconciled, orders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message });
  }
}

export const handler = wrapHandler("ebay-sync", handle);
