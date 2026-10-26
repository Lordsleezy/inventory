/**
 * eBay real fees → ledger → frozen commission. Runs against PGlite after all migrations.
 *
 *   node --experimental-strip-types scripts/test-ebay-fees.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { replayMigrationPaths } from "./lib/replay-migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stubPath = path.join(root, "supabase", "tests", "pglite-stub.sql");

const STORE = "00000000-0000-0000-0000-000000000212";
const OWNER = "00000000-0000-0000-0000-000000000211";
const JACOB = "00000000-0000-0000-0000-000000000213";
const CLERK = "00000000-0000-0000-0000-000000000214";

const db = new PGlite();
await db.exec(await readFile(stubPath, "utf8"));
for (const file of replayMigrationPaths(root)) {
  const sql = await readFile(file, "utf8");
  await db.exec(sql.replace(/create extension if not exists pgcrypto;/gi, "-- pglite stub"));
}

const as = async (role, sub) => {
  await db.exec(`select set_config('request.jwt.claim.role','${role}',false)`);
  if (sub) await db.exec(`select set_config('request.jwt.claim.sub','${sub}',false)`);
};

await db.exec(`
  insert into auth.users(id) values ('${OWNER}'),('${JACOB}'),('${CLERK}');
  insert into public.stores(id) values ('${STORE}');
  insert into public.staff(user_id,store_id,display_name,role) values
    ('${OWNER}','${STORE}','Paul','owner'),('${JACOB}','${STORE}','Jacob','staff'),('${CLERK}','${STORE}','Clerk','staff');
  insert into public.portal_admins(user_id,store_id) values ('${OWNER}','${STORE}');
  select set_config('request.jwt.claim.sub','${OWNER}',false);
  select set_config('request.jwt.claim.role','authenticated',false);
  select public.seed_store_settings('${STORE}','eBay fee test');
  insert into public.store_payout_people(store_id,slot,employee_id) values ('${STORE}','paul','${OWNER}'),('${STORE}','jacob','${JACOB}');
  insert into public.portal_payout_rules(store_id,employee_id,method,rate) values
    ('${STORE}','${OWNER}','percent_profit',20),('${STORE}','${JACOB}','percent_profit',10);
  insert into public.store_settings(store_id,key,value) values
    ('${STORE}','tax_remitted_channels','["ebay"]'::jsonb)
  on conflict(store_id,key) do update set value=excluded.value;
`);

const addUnit = async (sku, cost = 4000) => {
  await db.query(`insert into public.sku_ledger(sku,issued_at,store_id) values ($1,now(),'${STORE}')`, [sku]);
  await db.query(`insert into public.units(sku,title,ask_cents,floor_cents,state,store_id,received_at,updated_at,category,acquisition_cost_cents)
    values($1,'Unit ' || $1,20000,100,'available','${STORE}',now(),now(),'other',$2)`, [sku, cost]);
};
// An eBay sale as the order sync records it: sale row first, then the channel_orders row. No estimated fee.
const ebaySale = async (sku, orderId, { price = 10000, soldAt = "now()" } = {}) => {
  await addUnit(sku);
  await db.query(`insert into public.sales(store_id,sku,qty,sold_at,price_cents,tax_cents,channel,payment_method,payment_id,receipt_no)
    values('${STORE}',$1,1,${soldAt},$2,0,'ebay','marketplace','ebay:'||$3,'E-'||$3)`, [sku, price, orderId]);
  await db.query(`insert into public.channel_orders(store_id,provider,order_id,sku,sale_id,item_cents)
    values('${STORE}','ebay',$1,$2,(select id from public.sales where sku=$2),$3)`, [orderId, sku, price]);
};
const ledger = async (sku) => (await db.query(`select * from public.sale_ledger where sku = $1`, [sku])).rows[0];
const comm = async (sku) =>
  Object.fromEntries((await db.query(`select c.employee_id, c.amount_cents from public.sale_commissions c
    join public.sales s on s.id = c.sale_id where s.sku = $1`, [sku])).rows.map((r) => [r.employee_id, r.amount_cents]));
const line = async (sku) =>
  (await db.query(`select l.* from public.sale_payout_lines l join public.sales s on s.id = l.sale_id where s.sku = $1`, [sku])).rows[0];
const record = (orderId, rows, { saleAt = null, net = null, tax = null, label = null } = {}) =>
  db.query(`select public.ebay_record_order_fees('${STORE}',$1,$2::jsonb,$3,$4,$5,$6) as r`,
    [orderId, JSON.stringify(rows), saleAt, net, tax, label]);
const saleFees = (txn, date, ad = 0) => [
  { fee_type: "FINAL_VALUE_FEE", amount_cents: 1300, txn_id: txn, txn_type: "SALE", txn_date: date, line_item_id: "L1" },
  { fee_type: "FINAL_VALUE_FEE_FIXED_PER_ORDER", amount_cents: 30, txn_id: txn, txn_type: "SALE", txn_date: date, line_item_id: "L1" },
  ...(ad ? [{ fee_type: "AD_FEE", amount_cents: ad, txn_id: txn, txn_type: "SALE", txn_date: date, line_item_id: "L1" }] : []),
];
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

// ── 1) No estimate: an eBay sale with no stored fees has no fee, never a guessed one ───────────────
await as("service_role");
await ebaySale("93001", "ORD-1");
let l = await ledger("93001");
assert.equal(l.channel_fee_cents, 0); assert.equal(l.fee_source, "none");
console.log("no eBay estimate in the ledger ok");

// ── 2) Commission does not freeze before fees: line exists, base null, every amount null ─────────
let ln = await line("93001");
assert.equal(ln.fees_pending, true); assert.equal(ln.commission_base_cents, null);
assert.deepEqual(Object.values(await comm("93001")), [null, null]);
// Finances shows the sale, but the grace period (72h default) has not passed → still waiting.
await record("ORD-1", saleFees("TX-1", hoursAgo(1)), { saleAt: hoursAgo(1), net: 8670 });
l = await ledger("93001");
assert.equal(l.channel_fee_cents, 1330); assert.equal(l.fee_source, "actual");
assert.equal(l.profit_cents, 10000 - 1330 - 4000);
assert.equal((await db.query(`select public.ebay_fee_settle_due('${STORE}') as n`)).rows[0].n, 0);
ln = await line("93001");
assert.equal(ln.fees_pending, true, "still inside the grace period");
assert.deepEqual(Object.values(await comm("93001")), [null, null]);
console.log("commission waits on eBay fees (fees seen, grace not over) ok");

// ── 3) An ad fee arriving after the sale attaches to the right sale and lowers profit ───────────
await ebaySale("93002", "ORD-2");
await record("ORD-2", saleFees("TX-2", hoursAgo(1)), { saleAt: hoursAgo(1) });
const beforeAd = (await ledger("93002")).profit_cents;
await record("ORD-2", [
  { fee_type: "AD_FEE", amount_cents: 800, txn_id: "TX-2-AD", txn_type: "NON_SALE_CHARGE", txn_date: hoursAgo(0.5), line_item_id: "" },
]);
l = await ledger("93002");
assert.equal(l.channel_fee_cents, 1330 + 800);
assert.equal(l.profit_cents, beforeAd - 800);
const co = (await db.query(`select * from public.channel_orders where order_id = 'ORD-2'`)).rows[0];
assert.equal(co.ad_fee_cents, 800); assert.equal(co.fee_cents, 2130);
// …and not onto the other sale.
assert.equal((await ledger("93001")).channel_fee_cents, 1330);
// Each fee type is stored separately.
const types = (await db.query(`select fee_type, amount_cents from public.ebay_order_fees where order_id = 'ORD-2' order by fee_type`)).rows;
assert.deepEqual(types.map((r) => r.fee_type), ["AD_FEE", "FINAL_VALUE_FEE", "FINAL_VALUE_FEE_FIXED_PER_ORDER"]);
// Re-recording the same transaction is idempotent.
await record("ORD-2", saleFees("TX-2", hoursAgo(1)), { saleAt: hoursAgo(1) });
assert.equal((await ledger("93002")).channel_fee_cents, 2130);
console.log("late ad fee attaches to its sale and lowers profit ok");

// ── 4) Grace over → commission freezes on the real fees, including the late ad fee ───────────────
await ebaySale("93003", "ORD-3");
await record("ORD-3", saleFees("TX-3", hoursAgo(80)), { saleAt: hoursAgo(80) });
await record("ORD-3", [
  { fee_type: "AD_FEE", amount_cents: 800, txn_id: "TX-3-AD", txn_type: "NON_SALE_CHARGE", txn_date: hoursAgo(75), line_item_id: "" },
]);
assert.equal((await db.query(`select public.ebay_fee_settle_due('${STORE}') as n`)).rows[0].n, 1);
ln = await line("93003");
assert.equal(ln.fees_pending, false);
const base3 = 10000 - 2130 - 4000;
assert.equal(ln.commission_base_cents, base3);
let c3 = await comm("93003");
assert.equal(c3[OWNER], Math.round(base3 * 0.2)); assert.equal(c3[JACOB], Math.round(base3 * 0.1));
// A fee arriving after the freeze changes the ledger but not the frozen commission.
await record("ORD-3", [
  { fee_type: "AD_FEE", amount_cents: 500, txn_id: "TX-3-AD2", txn_type: "NON_SALE_CHARGE", txn_date: hoursAgo(1), line_item_id: "" },
]);
assert.equal((await ledger("93003")).channel_fee_cents, 2630);
assert.equal((await comm("93003"))[OWNER], Math.round(base3 * 0.2));
console.log("commission freezes after grace on real fees ok");

// ── 5) Overrides: a per-sale override applies to the real base once fees are final ──────────────
await ebaySale("93004", "ORD-4");
const tk = (await db.query(`select coalesce(ticket_id::text,'sale:'||id::text) k from public.sales where sku='93004'`)).rows[0].k;
await db.query(`insert into public.portal_commission_overrides(store_id,ticket_key,paul_pct,jacob_pct,updated_by)
  values ('${STORE}',$1,50,25,'${OWNER}')`, [tk]);
assert.deepEqual(Object.values(await comm("93004")), [null, null], "override cannot pay out before fees are final");
await record("ORD-4", saleFees("TX-4", hoursAgo(90)), { saleAt: hoursAgo(90) });
await db.query(`select public.ebay_fee_settle_due('${STORE}')`);
const base4 = 10000 - 1330 - 4000;
let c4 = await comm("93004");
assert.equal(c4[OWNER], Math.round(base4 * 0.5)); assert.equal(c4[JACOB], Math.round(base4 * 0.25));
console.log("override applies after fees settle ok");

// ── 6) No-cost rule still holds: real fees in, cost missing → still waiting on cost ──────────────
await db.query(`insert into public.sku_ledger(sku,issued_at,store_id) values ('93005',now(),'${STORE}')`);
await db.query(`insert into public.units(sku,title,ask_cents,floor_cents,state,store_id,received_at,updated_at,category,acquisition_cost_cents)
  values('93005','No cost',20000,100,'available','${STORE}',now(),now(),'other',null)`);
await db.query(`insert into public.sales(store_id,sku,qty,sold_at,price_cents,tax_cents,channel,payment_method,payment_id,receipt_no)
  values('${STORE}','93005',1,now(),10000,0,'ebay','marketplace','ebay:ORD-5','E-5')`);
await db.query(`insert into public.channel_orders(store_id,provider,order_id,sku,sale_id,item_cents)
  values('${STORE}','ebay','ORD-5','93005',(select id from public.sales where sku='93005'),10000)`);
await record("ORD-5", saleFees("TX-5", hoursAgo(90)), { saleAt: hoursAgo(90) });
await db.query(`select public.ebay_fee_settle_due('${STORE}')`);
assert.deepEqual(Object.values(await comm("93005")), [null, null]);
await db.query(`update public.units set acquisition_cost_cents = 4000 where sku = '93005'`);
assert.equal((await comm("93005"))[OWNER], Math.round((10000 - 1330 - 4000) * 0.2));
console.log("no-cost rule intact; cost filled later pays on the real-fee base ok");

// ── 7) Returns: a return on an eBay sale still claws back from the frozen commission ────────────
assert.equal(await db.query(`select public.sale_commission_cents('${STORE}', (select id from public.sales where sku='93003'), '${OWNER}') as c`)
  .then((r) => r.rows[0].c), Math.round(base3 * 0.2));
await db.query(`select public.sale_commission_cents('${STORE}', (select id from public.sales where sku='93001'), '${OWNER}')`); // pending → 0, no error
console.log("returns read the frozen / waiting amounts ok");

// ── 8) History: unpaid frozen sale is re-based, paid-out sale is never rewritten ────────────────
// Two old eBay sales frozen on an old estimate (fee 1322) before real fees existed.
for (const [sku, order, day] of [["93010", "ORD-10", "now() - interval '40 days'"], ["93011", "ORD-11", "now() - interval '20 days'"]]) {
  await ebaySale(sku, order, { soldAt: day });
  await db.query(`update public.channel_orders set fee_cents = 1322, fee_source = 'estimated', fees_settled_at = now() where order_id = $1`, [order]);
  await db.query(`select public.payout_release_ebay_fees((select id from public.sales where sku = $1))`, [sku]);
}
// (release ran on a pending line created before the estimate existed → both frozen on the estimate fee)
const old10 = (await comm("93010"))[OWNER];
const old11 = (await comm("93011"))[OWNER];
assert.equal(old10, Math.round((10000 - 1322 - 4000) * 0.2));
// Paul was paid exactly the older sale's commission (plus nothing for 93011); earlier sales were paid too.
const paidSoFar = (await db.query(`select coalesce(sum(coalesce(c.amount_cents,0)),0)::int t from public.sale_commissions c
  join public.sales s on s.id = c.sale_id where c.employee_id = '${OWNER}' and s.sold_at <= now() - interval '30 days'`)).rows[0].t;
await db.query(`insert into public.portal_payout_payments(store_id,employee_id,amount_cents,paid_by) values ('${STORE}','${OWNER}',$1,'${OWNER}')`, [paidSoFar]);
const status = (await db.query(`select s.sku, p.paid_cents from public.ebay_commission_paid_status('${STORE}') p
  join public.sales s on s.id = p.sale_id where p.employee_id = '${OWNER}' and s.sku in ('93010','93011')`)).rows;
assert.ok(status.find((r) => r.sku === "93010").paid_cents > 0, "older sale counts as paid out");
assert.equal(status.find((r) => r.sku === "93011").paid_cents, 0, "newer sale is unpaid");
// Real fees (with a promoted-listing ad fee) arrive for both.
for (const order of ["ORD-10", "ORD-11"]) {
  await record(order, saleFees("TX-" + order, hoursAgo(500), 900), { saleAt: hoursAgo(500) });
}
// Dry run on the unpaid sale reports the change but writes nothing.
const dry = (await db.query(`select public.payout_refresh_ebay_fees((select id from public.sales where sku='93011'), true, 2230) as r`)).rows[0].r;
assert.equal(dry.status, "dry_run");
assert.equal(dry.after[OWNER], Math.round((10000 - 2230 - 4000) * 0.2));
assert.equal((await comm("93011"))[OWNER], old11, "dry run wrote nothing");
// Apply.
const applied = (await db.query(`select public.payout_refresh_ebay_fees((select id from public.sales where sku='93011')) as r`)).rows[0].r;
assert.equal(applied.status, "updated");
assert.equal((await comm("93011"))[OWNER], Math.round((10000 - 2230 - 4000) * 0.2));
// Paid-out sale: refused, commission untouched, even though its real fees are now in the ledger.
const refused = (await db.query(`select public.payout_refresh_ebay_fees((select id from public.sales where sku='93010')) as r`)).rows[0].r;
assert.equal(refused.status, "paid_out");
assert.equal(refused.paid_cents, old10, "reports what was paid");
assert.equal(refused.after[OWNER], Math.round((10000 - 2230 - 4000) * 0.2), "shows what it would have become");
assert.equal((await comm("93010"))[OWNER], old10);
assert.equal((await ledger("93010")).channel_fee_cents, 2230, "ledger still shows the real fee for reports");
console.log("history: unpaid re-based, paid-out commission never rewritten ok");

// ── 9) Reports: ad fees on their own line ───────────────────────────────────────────────────────
// Unattached ad campaign charge (no order): stored without an order, not part of any sale.
await db.query(`insert into public.ebay_order_fees(store_id,order_id,fee_type,amount_cents,txn_id,txn_type,txn_date)
  values ('${STORE}',null,'PREMIUM_AD_FEES',1500,'CAMP-1','NON_SALE_CHARGE',now())`);
await as("authenticated", OWNER);
const rep = (await db.query(`select public.portal_ebay_ad_fee_report(current_date - 90, current_date + 1) as r`)).rows[0].r;
const report = typeof rep === "string" ? JSON.parse(rep) : rep;
assert.equal(report.attached_cents, 800 + (800 + 500) + 900 + 900, "ORD-2, ORD-3 (incl. post-freeze charge), ORD-10, ORD-11");
assert.equal(report.unattached_cents, 1500);
assert.equal(report.ad_fee_cents, report.attached_cents + 1500);
console.log("reports: ad fee line ok");

// ── 10) Clerks still see no money ───────────────────────────────────────────────────────────────
await as("authenticated", CLERK);
await assert.rejects(db.query(`select public.portal_ebay_ad_fee_report(current_date - 90, current_date + 1)`), /portal_access_denied/);
await assert.rejects(db.query(`select * from public.portal_payout_commissions()`), /portal_access_denied/);
await db.exec(`set role authenticated`);
assert.equal((await db.query(`select count(*)::int n from public.ebay_order_fees`)).rows[0].n, 0, "clerk reads no fee rows");
assert.equal((await db.query(`select count(*)::int n from public.channel_orders`)).rows[0].n, 0, "clerk reads no order money");
assert.equal((await db.query(`select count(*)::int n from public.sale_commissions`)).rows[0].n, 0, "clerk reads no commissions");
await assert.rejects(db.query(`select public.ebay_record_order_fees('${STORE}','ORD-1','[]'::jsonb)`), /permission denied|assert_service|not allowed|service/i);
await db.exec(`reset role`);
await as("authenticated", OWNER);
await db.exec(`set role authenticated`);
assert.ok((await db.query(`select count(*)::int n from public.ebay_order_fees`)).rows[0].n > 0, "admin reads fee rows");
const waiting = (await db.query(`select * from public.portal_payout_commissions()`)).rows;
assert.ok(waiting.some((r) => r.waiting_fees === true && r.amount_cents === null), "admin sees a sale waiting on eBay fees");
await db.exec(`reset role`);
console.log("clerks see no eBay money; admin sees waiting_fees ok");

await db.close();
console.log("ebay fee tests ok");
