import { json, corsHeaders } from "../lib/server.mjs";
import { pollAllStores, withdrawOpenEbayTasks } from "../lib/ebay.mjs";
import { wrapHandler } from "../lib/floor-log.mjs";

async function handle(event) {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const withdrawn = await withdrawOpenEbayTasks();
    const orders = await pollAllStores();
    return json(200, { withdrawn, orders });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(500, { error: message });
  }
}

export const handler = wrapHandler("ebay-sync", handle);
