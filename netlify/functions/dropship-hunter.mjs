/**
 * Nightly hunter — scores US catalog into pending picks.
 * No-op when dropship is OFF.
 */
import { serviceClient, json } from "../lib/server.mjs";
import { netlifyHandler } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { runHunter } from "../lib/dropship/picks.mjs";

async function handle(event) {
  if (!isNetlifyScheduleEvent(event) && event.httpMethod && event.httpMethod !== "POST") {
    return json(405, { error: "method" });
  }
  const sb = serviceClient();
  const { data: stores } = await sb.from("dropship_settings").select("store_id, enabled").eq("enabled", true);
  const out = [];
  for (const row of stores || []) {
    try {
      out.push({ storeId: row.store_id, ...(await runHunter(row.store_id)) });
    } catch (err) {
      out.push({ storeId: row.store_id, error: err.message });
    }
  }
  return json(200, { ok: true, results: out });
}

export const handler = netlifyHandler("dropship-hunter", handle);