// Payout parity check for 20261030150000_payout_snapshots.sql.
// Recomputes every person's commission total with the Payouts screen's own code (apps/admin/src/payouts.ts)
// from live data, and (after the migration) compares it with the frozen totals in sale_commissions.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node --experimental-strip-types scripts/payout-parity.mjs --store <uuid> --out before.json   # before applying
//   node --experimental-strip-types scripts/payout-parity.mjs --store <uuid> --compare before.json # after applying
// Exit code 1 on any mismatch.
import { readFileSync, writeFileSync } from "node:fs";
import { payout } from "../apps/admin/src/payouts.ts";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const store = arg("--store");
const out = arg("--out");
const compare = arg("--compare");
const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!store || !url || !key) {
  console.error("usage: SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. payout-parity.mjs --store <uuid> [--out f] [--compare f]");
  process.exit(2);
}
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function rest(path, { optional = false } = {}) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers: { ...headers, Range: `${from}-${from + 999}` } });
    if (!res.ok) {
      if (optional && (res.status === 404 || res.status === 400)) return null;
      throw new Error(`${path}: ${res.status} ${await res.text()}`);
    }
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}
async function rpc(name, body) {
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Values that were hardcoded in payouts.ts before the migration (used only if the new tables are absent).
const LEGACY_SLOTS = { paul: "f17e6163-b10a-4fe1-a373-75c0094e5363", jacob: "c851c8ee-2cc2-490f-935f-1e2d7e093d88" };
const LEGACY_SKU = { "11314": { jacob: 25, paul: 5 }, "11386": { jacob: 20, paul: 10 }, "11415": { jacob: 20, paul: 10 },
  "11522": { jacob: 25, paul: 5 }, "99694": { jacob: 0, paul: 30 }, "11629": { jacob: 20, paul: 10 }, "99695": { jacob: 20, paul: 10 } };

const s = `store_id=eq.${store}`;
const [lines, rules, settings, overrides, people, skuRows] = await Promise.all([
  rest(`sale_ledger?${s}&voided_at=is.null&select=id,ticket_id,sku,price_cents,cost_cents,channel&order=id`),
  rest(`portal_payout_rules?${s}&select=employee_id,method,rate`),
  rest(`store_settings?${s}&key=in.(online_channels,online_payout_pct,online_payout_employee_id)&select=key,value`),
  rest(`portal_commission_overrides?${s}&select=ticket_key,paul_pct,jacob_pct`),
  rest(`store_payout_people?${s}&select=slot,employee_id`, { optional: true }),
  rest(`store_payout_sku_rates?${s}&select=sku,employee_id,rate`, { optional: true }),
]);
const setting = (k, d) => { const r = settings.find((x) => x.key === k); return r ? r.value : d; };
const slots = people ? Object.fromEntries(people.map((p) => [p.slot, p.employee_id])) : LEGACY_SLOTS;
const skuRates = {};
if (skuRows) for (const r of skuRows) (skuRates[r.sku] ||= {})[r.employee_id] = Number(r.rate);
else for (const [sku, m] of Object.entries(LEGACY_SKU)) for (const [slot, rate] of Object.entries(m)) (skuRates[sku] ||= {})[LEGACY_SLOTS[slot]] = rate;
const cfg = {
  channels: (setting("online_channels", ["website"]) || []).map((c) => String(c).toLowerCase()),
  pct: Number(setting("online_payout_pct", 30)) || 0,
  employeeId: setting("online_payout_employee_id", null),
  slots, skuRates,
};
const ov = new Map(overrides.map((o) => [o.ticket_key, { paulPct: Number(o.paul_pct), jacobPct: Number(o.jacob_pct) }]));

// Same grouping as apps/admin/src/App.tsx tickets() (portal_payout_sales carries no buyer shipping).
const tickets = new Map();
for (const l of lines) {
  const k = l.ticket_id || `sale:${l.id}`;
  let t = tickets.get(k);
  if (!t) tickets.set(k, t = { key: k, subtotal: 0, cost: 0, channel: l.channel, lines: [], commissionOverride: ov.get(k) || null });
  t.subtotal += l.price_cents;
  t.lines.push({ sku: l.sku, price_cents: l.price_cents, cost_cents: l.cost_cents });
  if (l.cost_cents === null) t.cost = null; else if (t.cost !== null) t.cost += l.cost_cents;
}
const people_ = [...rules];
if (cfg.employeeId && !people_.some((r) => r.employee_id === cfg.employeeId)) people_.push({ employee_id: cfg.employeeId, method: "percent_sale", rate: 0 });

const browser = {}, pending = {}, perTicket = new Map();
for (const t of tickets.values()) for (const r of people_) {
  const a = payout(t, r, cfg);
  perTicket.set(`${t.key}|${r.employee_id}`, a);
  if (a === null) pending[r.employee_id] = (pending[r.employee_id] || 0) + 1;
  else browser[r.employee_id] = (browser[r.employee_id] || 0) + a;
}
const result = { store, at: new Date().toISOString(), tickets: tickets.size, browser_totals: browser, browser_pending: pending };

const snap = await rpc("payout_commission_totals", { p_store: store });
let failed = false;
if (snap) {
  result.snapshot_totals = Object.fromEntries(snap.map((r) => [r.employee_id, Number(r.commission_cents)]));
  result.snapshot_pending = Object.fromEntries(snap.map((r) => [r.employee_id, Number(r.pending_tickets)]));
  const commissions = await rest(`sale_commissions?${s}&select=sale_id,ticket_key,employee_id,amount_cents`);
  const live = new Set(lines.map((l) => l.id));
  const frozen = new Map();
  for (const c of commissions) {
    if (!live.has(c.sale_id)) continue;
    const k = `${c.ticket_key}|${c.employee_id}`;
    const prev = frozen.has(k) ? frozen.get(k) : 0;
    frozen.set(k, prev === null || c.amount_cents === null ? null : prev + c.amount_cents);
  }
  const diffs = [];
  for (const [k, a] of perTicket) {
    const f = frozen.has(k) ? frozen.get(k) : 0;
    if ((a ?? null) !== (f ?? null) && !(a === 0 && f === undefined)) diffs.push({ key: k, screen: a, frozen: f });
  }
  result.ticket_diffs = diffs.slice(0, 50);
  result.ticket_diff_count = diffs.length;
  if (diffs.length) failed = true;
}
if (compare) {
  const before = JSON.parse(readFileSync(compare, "utf8"));
  const ids = new Set([...Object.keys(before.browser_totals), ...Object.keys(result.snapshot_totals || {})]);
  result.compare = [...ids].map((id) => ({ employee_id: id, before_screen: before.browser_totals[id] || 0,
    after_frozen: (result.snapshot_totals || {})[id] || 0 }));
  if (result.compare.some((r) => r.before_screen !== r.after_frozen)) failed = true;
}
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, ticket_diffs: undefined }, null, 2));
console.log(failed ? "PARITY: MISMATCH" : "PARITY: OK");
process.exit(failed ? 1 : 0);
