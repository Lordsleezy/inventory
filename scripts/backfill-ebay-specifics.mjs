#!/usr/bin/env node
// One-time eBay specifics auto-fill for every in-stock unit (no AI): Floor UPC memory, eBay Catalog API by UPC,
// then Floor's product database. Never overwrites a value that is already set and never changes an existing category.
// Usage (needs Netlify env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_ENV):
//   node scripts/backfill-ebay-specifics.mjs --store <uuid>            # dry run: reports, writes nothing
//   node scripts/backfill-ebay-specifics.mjs --store <uuid> --write    # fills blanks
import { serviceClient } from "../netlify/lib/server.mjs";
import { catalogProductByGtin } from "../netlify/lib/ebay-catalog.mjs";
import { ebayAspectFields } from "../netlify/functions/ebay-specifics.mjs";
import { autofillUnitSpecifics, missingRequired, supabaseSpecificsDeps } from "../netlify/lib/ebay-specifics.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const storeId = arg("--store");
const write = process.argv.includes("--write");
if (!storeId) { console.error("--store <uuid> required"); process.exit(2); }

const sb = serviceClient();
const deps = supabaseSpecificsDeps(sb, { catalog: catalogProductByGtin, aspectFields: (id) => ebayAspectFields(storeId, id) });
const { data: units, error } = await sb.from("units").select("sku").eq("store_id", storeId)
  .in("state", ["available", "reserved", "repair"]).order("sku");
if (error) throw new Error(error.message);

const tally = { units: units.length, was_complete: 0, now_complete: 0, became_complete: 0, category_filled: 0,
  still_missing_required: 0, no_category: 0, ebay_disabled: 0, errors: 0 };
for (const { sku } of units) {
  try {
    const row = await deps.loadEbayRow(storeId, sku);
    const before = row?.category_id ? missingRequired(await ebayAspectFields(storeId, row.category_id), row.attributes || {}) : null;
    const wasComplete = Array.isArray(before) && before.length === 0;
    const r = await autofillUnitSpecifics(deps, storeId, sku, { write });
    if (r.skipped) { tally.ebay_disabled++; continue; }
    if (wasComplete) tally.was_complete++;
    if (r.reason === "no_category") { tally.no_category++; continue; }
    if (r.categorySource) tally.category_filled++;
    if (r.complete) { tally.now_complete++; if (!wasComplete) tally.became_complete++; }
    else tally.still_missing_required++;
  } catch (e) { tally.errors++; console.error(sku, String(e?.message || e)); }
}
console.log(JSON.stringify({ dry_run: !write, ...tally }, null, 2));
