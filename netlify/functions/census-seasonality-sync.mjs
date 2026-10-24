import { serviceClient, json } from "../lib/server.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";
import { CENSUS_QUARTERS_URL, parseCensusQuarters } from "../lib/census-seasonality.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";

async function handle(event) {
  if (!isNetlifyScheduleEvent(event)) return json(403, { error: "schedule_only" });
  const response = await fetch(CENSUS_QUARTERS_URL, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) return json(502, { error: "census_unavailable", status: response.status });
  const rows = parseCensusQuarters(await response.text());
  if (rows.length < 12) return json(502, { error: "census_format_changed" });
  const { error } = await serviceClient().from("census_ecommerce_quarters")
    .upsert(rows, { onConflict: "year,quarter" });
  if (error) throw error;
  return json(200, { ok: true, quarters: rows.length });
}
export const invoke = wrapHandler("census-seasonality-sync", handle);
export default asNetlifyFunction(invoke);
