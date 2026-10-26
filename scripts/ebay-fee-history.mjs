#!/usr/bin/env node
// One-time eBay fee history pass (run by the PC agent against live, after the real-fees release is deployed
// and eBay has been reconnected with the sell.finances permission).
//
//   node scripts/ebay-fee-history.mjs --store <uuid>            # DRY RUN: writes nothing, prints the per-sale diff
//   node scripts/ebay-fee-history.mjs --store <uuid> --apply    # records real fees; re-bases UNPAID sales only
//
// Needs Netlify env: SUPABASE_URL, SUPABASE_SERVICE_ROLE, EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_ENV=production.
// Output: reports/ebay-fee-history-<mode>-<timestamp>.csv (every sale) and .paid-out.txt (paid-out sales + dollars).
// NEVER rewrites commission already paid out; those sales are only listed.
import { mkdirSync, writeFileSync } from "node:fs";
import { serviceClient } from "../netlify/lib/server.mjs";
import { runEbayFeeHistory, historyCsv, paidOutText } from "../netlify/lib/ebay-fee-history.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const storeId = arg("--store") || process.env.STORE_ID;
const apply = process.argv.includes("--apply");
if (!storeId) { console.error("--store <uuid> required"); process.exit(2); }

const sb = serviceClient();
const { rows, paidOut, summary } = await runEbayFeeHistory(sb, storeId, { apply });

mkdirSync("reports", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const base = `reports/ebay-fee-history-${summary.mode}-${stamp}`;
writeFileSync(`${base}.csv`, historyCsv(rows));
writeFileSync(`${base}.paid-out.txt`, paidOutText(paidOut));

console.log(JSON.stringify(summary, null, 2));
console.log(paidOutText(paidOut));
console.log(`Per-sale diff: ${base}.csv`);
if (!apply) console.log("DRY RUN: nothing was written. Re-run with --apply to record the real fees.");
