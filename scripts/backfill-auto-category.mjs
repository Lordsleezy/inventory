#!/usr/bin/env node
// One-time: give every eligible in-stock unit an eBay category (eBay's top suggestion for the title, tagged Auto, specifics pre-filled)
// and a generated description. No AI. Skips Defective, do-not-list / DNS and never-list units. Never changes a category or description
// that is already set, never checks a channel, never lists anything. Backs up the rows it may change before writing.
// Usage (needs Netlify env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_ENV):
//   node scripts/backfill-auto-category.mjs --store <uuid> [--backup <dir>]            # dry run: reports, writes nothing
//   node scripts/backfill-auto-category.mjs --store <uuid> --backup <dir> --write
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serviceClient } from "../netlify/lib/server.mjs";
import { catalogProductByGtin, suggestCategories } from "../netlify/lib/ebay-catalog.mjs";
import { liveSpecificsForUnit } from "../netlify/lib/ebay-live-specifics.mjs";
import { ebayAspectFields } from "../netlify/functions/ebay-specifics.mjs";
import { supabaseSpecificsDeps } from "../netlify/lib/ebay-specifics.mjs";
import { autoFillUnit, supabaseAutoFillDeps } from "../netlify/lib/auto-fill.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const storeId = arg("--store");
const backupDir = arg("--backup");
const write = process.argv.includes("--write");
if (!storeId) { console.error("--store <uuid> required"); process.exit(2); }
if (write && !backupDir) { console.error("--backup <dir> required with --write"); process.exit(2); }

const sb = serviceClient();
// One unit per call (the all-units version computes every unit's gaps in one statement and times out).
const snapshot = async () => {
  const { data: units, error } = await sb.from("units").select("sku").eq("store_id", storeId).in("state", ["available", "reserved", "repair"]).limit(5000);
  if (error) throw new Error(error.message);
  const rows = []; let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < units.length) {
      const { sku } = units[i++];
      const { data, error: e } = await sb.rpc("floor_auto_fill_snapshot", { p_store: storeId, p_sku: sku });
      if (e) throw new Error(`${sku}: ${e.message}`);
      rows.push(...(data || []));
    }
  }));
  return rows;
};
const specificsDeps = supabaseSpecificsDeps(sb, { catalog: catalogProductByGtin, aspectFields: (id) => ebayAspectFields(storeId, id),
  loadLive: (sid, sku) => liveSpecificsForUnit(sid, sku) });
const af = supabaseAutoFillDeps(sb, { suggestCategories, specificsDeps, ebayAspectFields: (id) => ebayAspectFields(storeId, id) });

const before = await snapshot();
const todo = before.filter((r) => r.eligible && ((!r.has_category && String(r.title || "").trim()) || (!r.has_description && r.has_name)));

if (write) {
  mkdirSync(backupDir, { recursive: true });
  const skus = todo.map((r) => r.sku);
  const { data: cats } = await sb.from("unit_channel_categories").select("*").eq("store_id", storeId).eq("channel", "ebay").in("sku", skus);
  const { data: units } = await sb.from("units").select("sku,title,listing_body,listing_specs").eq("store_id", storeId).in("sku", skus);
  writeFileSync(path.join(backupDir, "unit_channel_categories.json"), JSON.stringify(cats, null, 1));
  writeFileSync(path.join(backupDir, "units.json"), JSON.stringify(units, null, 1));
}

const tally = { in_stock: before.length, eligible: before.filter((r) => r.eligible).length, attempted: todo.length,
  category_set: 0, category_from_floor_data: 0, no_suggestion: 0, suggestion_error: 0, description_set: 0, errors: 0 };
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(4, todo.length) }, async () => {
  while (cursor < todo.length) {
    const { sku } = todo[cursor++];
    try {
      const r = await autoFillUnit(af, storeId, sku, { write });
      if (r.category === "set_auto_suggested") tally.category_set++;
      else if (String(r.category).startsWith("set_")) tally.category_from_floor_data++;
      else if (r.category === "no_suggestion") tally.no_suggestion++;
      else if (r.category === "suggestion_error") tally.suggestion_error++;
      if (r.description === "set") tally.description_set++;
    } catch (e) { tally.errors++; console.error(sku, String(e?.message || e)); }
  }
}));

const after = write ? await snapshot() : before;
const list = (rows) => rows.filter((r) => r.eligible && r.unfinished);
const byReason = (rows) => {
  const out = {};
  for (const r of rows) for (const g of r.gaps || []) out[g] = (out[g] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};
const beforeSet = new Set(list(before).map((r) => r.sku));
const afterRows = new Map(after.map((r) => [r.sku, r]));
const movedToNeedsCheck = [...beforeSet].filter((sku) => afterRows.get(sku)?.needs_check).length;
const stillUnfinished = list(after);
console.log(JSON.stringify({ dry_run: !write, ...tally, unfinished_before: beforeSet.size, unfinished_after: stillUnfinished.length,
  moved_out_of_unfinished_into_needs_check: movedToNeedsCheck, still_unfinished_by_reason: byReason(stillUnfinished),
  still_unfinished_only_one_reason: Object.entries(stillUnfinished.filter((r) => (r.gaps || []).length === 1)
    .reduce((m, r) => ({ ...m, [r.gaps[0]]: (m[r.gaps[0]] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]) }, null, 1));
