// Static guard: every portal_* SQL function (newest definition in supabase/migrations) that
// touches money or cost must be gated to admins, either directly with portal_is_admin() or by
// scoping to portal_store_id() (which returns null unless portal_is_admin()).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
const defs = new Map();
const fnRe = /create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi;
for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
  const sql = readFileSync(join(dir, f), "utf8");
  for (const m of sql.matchAll(fnRe)) {
    const rest = sql.slice(m.index);
    const tag = /\bas\s+(\$\w*\$)/i.exec(rest);
    if (!tag) continue;
    const start = tag.index + tag[0].length;
    const end = rest.indexOf(tag[1], start);
    defs.set(m[1], { file: f, body: rest.slice(0, end < 0 ? undefined : end) });
  }
}

const MONEY = /\b(acquisition_cost_cents|cost_cents|ask_cents|msrp_cents|price_cents|sold_price\w*|total_cents|amount_cents|fee_cents|gross_cents|profit\w*|payout\w*|commission\w*)\b/i;
// Functions that only reach money for sellable/available units or are service-role only.
const ALLOW = new Set([
  "portal_paid_stamp", // trigger function, not an RPC
  "portal_upsert_ebay_fee_expense", // revoked from authenticated; service_role only
  "portal_vendoo_export", // retired stub, returns no rows
]);

test("portal_store_id() embeds portal_is_admin()", () => {
  const d = defs.get("portal_store_id");
  assert.ok(d, "portal_store_id defined");
  assert.match(d.body, /portal_is_admin\(\)/, `newest portal_store_id (${d.file}) must check portal_is_admin()`);
});

test("money-touching portal_* functions are admin-gated", () => {
  const bad = [];
  for (const [name, { file, body }] of defs) {
    if (!name.startsWith("portal_") || name === "portal_store_id" || name === "portal_is_admin") continue;
    if (ALLOW.has(name) || !MONEY.test(body)) continue;
    if (!/portal_is_admin\(\)|portal_store_id\(\)/.test(body)) bad.push(`${name} (${file})`);
  }
  assert.deepEqual(bad, [], `portal_* functions returning money without an admin gate:\n${bad.join("\n")}`);
});
