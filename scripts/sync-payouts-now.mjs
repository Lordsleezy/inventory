/**
 * Re-date Square and Open Box eBay payouts from the live APIs.
 * Matches on payout id (upsert). Never touches pgg124-5.
 *
 *   node scripts/sync-payouts-now.mjs
 * Reads .env.local / .env (SUPABASE_URL + SUPABASE_SERVICE_ROLE).
 */
import "./load-env.mjs";
import { createClient } from "@supabase/supabase-js";
import { syncStoreChannels } from "../netlify/functions/channel-fee-sync.mjs";

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log(JSON.stringify({
    ok: false,
    reason: "no_local_credentials",
    detail: "No .env.local or .env with SUPABASE_URL and SUPABASE_SERVICE_ROLE. The next scheduled channel-fee-sync will re-date payouts from the APIs.",
  }));
  process.exit(2);
}

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function rows() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("platform_withdrawals")
      .select("platform,withdrawn_on,amount_cents,created_at,occurred_at,external_payout_id")
      .in("platform", ["square", "ebay"])
      .is("voided_at", null)
      .not("external_payout_id", "is", null)
      .gte("withdrawn_on", "2025-01-01")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return all;
}

function summarize(list) {
  const out = {};
  for (const row of list) {
    const month = String(row.withdrawn_on || "").slice(0, 7);
    if (month !== "2026-10" && month !== "2026-11") continue;
    const key = `${row.platform} ${month}`;
    const cur = out[key] || { count: 0, cents: 0, import_day_count: 0 };
    cur.count += 1;
    cur.cents += Number(row.amount_cents || 0);
    const imported = String(row.created_at || "").slice(0, 10);
    const shown = String(row.occurred_at || row.created_at || "").slice(0, 10);
    if (shown && shown === imported && shown !== row.withdrawn_on) cur.import_day_count += 1;
    if (row.withdrawn_on === "2026-11-03") cur.import_day_count += 1;
    out[key] = cur;
  }
  for (const key of Object.keys(out)) out[key].dollars = (out[key].cents / 100).toFixed(2);
  return out;
}

const before = summarize(await rows());
const { data: stores, error } = await sb.from("stores").select("id");
if (error) throw new Error(error.message);
const logs = {};
for (const store of stores || []) {
  const log = [];
  await syncStoreChannels(sb, store.id, log, { forceMoney: true });
  const imported = log.filter((row) => row && row.imported).length;
  const errors = log.filter((row) => row && (row.payoutError || row.ebay || row.squarePayouts)).slice(0, 8);
  logs[store.id] = { events: log.length, imported, errors };
}
const after = summarize(await rows());
console.log(JSON.stringify({ ok: true, before, after, logs }, null, 2));
