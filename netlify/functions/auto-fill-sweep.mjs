import { serviceClient, json, corsHeaders } from "../lib/server.mjs";
import { suggestCategories } from "../lib/ebay-catalog.mjs";
import { catalogProductByGtin } from "../lib/ebay-catalog.mjs";
import { supabaseSpecificsDeps } from "../lib/ebay-specifics.mjs";
import { liveSpecificsForUnit } from "../lib/ebay-live-specifics.mjs";
import { autoFillUnit, autoFillCandidates, supabaseAutoFillDeps } from "../lib/auto-fill.mjs";
import { ebayAspectFields } from "./ebay-specifics.mjs";
import { wrapHandler, asNetlifyFunction } from "../lib/floor-log.mjs";
import { isNetlifyScheduleEvent } from "../lib/schedule.mjs";

// Scheduled (netlify.toml): units with no eBay category or no description get both filled in (new items, changed titles).
// A few units per run. Never ticks a channel, never lists, never changes a category or description that is already set.
async function handle(event) {
  if (event?.httpMethod === "OPTIONS") return { statusCode: 200, headers: corsHeaders(), body: "" };
  const sb = serviceClient();
  const { data: stores } = await sb.from("stores").select("id");
  const tally = { checked: 0, category_set: 0, description_set: 0, no_suggestion: 0, errors: 0 };
  for (const { id: storeId } of stores || []) {
    const specificsDeps = supabaseSpecificsDeps(sb, { catalog: catalogProductByGtin, aspectFields: (cid) => ebayAspectFields(storeId, cid),
      loadLive: (sid, s) => liveSpecificsForUnit(sid, s) });
    const af = supabaseAutoFillDeps(sb, { suggestCategories, specificsDeps, ebayAspectFields: (cid) => ebayAspectFields(storeId, cid) });
    for (const sku of await autoFillCandidates(sb, storeId, { limit: 6 }).catch(() => [])) {
      try {
        const r = await autoFillUnit(af, storeId, sku);
        tally.checked++;
        if (String(r.category).startsWith("set_")) tally.category_set++;
        if (r.category === "no_suggestion") tally.no_suggestion++;
        if (r.description === "set") tally.description_set++;
      } catch { tally.errors++; }
    }
  }
  return json(200, { ...tally, schedule: isNetlifyScheduleEvent(event) });
}

export const invoke = wrapHandler("auto-fill-sweep", handle);
export default asNetlifyFunction(invoke);
