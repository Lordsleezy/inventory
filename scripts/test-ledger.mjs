/**
 * sale_ledger economics per channel. Runs against PGlite after all migrations.
 *
 *   node --experimental-strip-types scripts/test-ledger.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { replayMigrationPaths } from "./lib/replay-migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stubPath = path.join(root, "supabase", "tests", "pglite-stub.sql");

const STORE = "00000000-0000-0000-0000-000000000112";
const OWNER = "00000000-0000-0000-0000-000000000111";

const db = new PGlite();
await db.exec(await readFile(stubPath, "utf8"));
for (const file of replayMigrationPaths(root)) {
  const sql = await readFile(file, "utf8");
  await db.exec(sql.replace(/create extension if not exists pgcrypto;/gi, "-- pglite stub"));
}

const ledger = async (sku) =>
  (await db.query(`select * from public.sale_ledger where sku = $1`, [sku])).rows[0];

await db.exec(`
  insert into auth.users(id) values ('${OWNER}');
  insert into public.stores(id) values ('${STORE}');
  insert into public.staff(user_id,store_id,display_name,role) values ('${OWNER}','${STORE}','Owner','owner');
  insert into public.portal_admins(user_id,store_id) values ('${OWNER}','${STORE}');
  select set_config('request.jwt.claim.sub','${OWNER}',false);
  select set_config('request.jwt.claim.role','authenticated',false);
  select public.seed_store_settings('${STORE}','Ledger test');
  insert into public.store_settings(store_id,key,value) values
    ('${STORE}','cost_defaults','{"refrigerators":25000,"dishwashers":25000,"mattresses":30000,"other":900}'::jsonb),
    ('${STORE}','channel_fee_rates','{"ebay":{"pct":13.25,"fixed_cents":40},"mercari":{"pct":10,"fixed_cents":0},"depop":{"pct":3.3,"fixed_cents":45},"whatnot":{"pct":10.9,"fixed_cents":30},"facebook":{"pct":5,"fixed_cents":40},"card_in_store":{"pct":2.6,"fixed_cents":15},"card_online":{"pct":3.3,"fixed_cents":30}}'::jsonb),
    ('${STORE}','tax_remitted_channels','["ebay","mercari","depop","whatnot","poshmark","facebook","etsy","grailed","vinted","vestiaire_collective","amazon","tiktok","shopify","vendoo","other"]'::jsonb),
    ('${STORE}','marketplace_channels','[{"key":"ebay"},{"key":"depop"},{"key":"mercari"},{"key":"whatnot"}]'::jsonb)
  on conflict(store_id,key) do update set value=excluded.value;
`);

const addUnit = async (sku, { ask = 10000, cost = null, category = "other", collectible = false } = {}) => {
  await db.query(`insert into public.sku_ledger(sku,issued_at,store_id) values ($1,now(),'${STORE}')`, [sku]);
  await db.query(`insert into public.units(sku,title,ask_cents,floor_cents,state,store_id,received_at,updated_at,category,acquisition_cost_cents,is_collectible)
    values($1,'Unit ' || $1,$2,100,'available','${STORE}',now(),now(),$3,$4,$5)`, [sku, ask, category, cost, collectible]);
};

// 1) In-store cash sale, real cost → profit = price − cost; card fee is pass-through.
await addUnit("92001", { ask: 10000, cost: 4000 });
await db.query(`insert into public.sales(store_id,sku,qty,sold_at,price_cents,tax_cents,card_fee_cents,channel,payment_method,receipt_no)
  values('${STORE}','92001',1,now(),10000,725,0,'floor','cash','0001')`);
let l = await ledger("92001");
assert.equal(l.cost_cents, 4000); assert.equal(l.cost_source, "unit");
assert.equal(l.channel_fee_cents, 0); assert.equal(l.ship_cost_cents, 0);
assert.equal(l.processing_fee_cents, 0);
assert.equal(l.profit_cents, 6000);
assert.equal(l.tax_owed_cents, 725); assert.equal(l.tax_remitted_by, "us");
assert.equal(l.variance_cents, 0);
console.log("in-store cash: profit 6000, tax owed 725 ok");

// 2) In-store card sale → no Square fee estimate; processing stays pending until Square reports it.
await addUnit("92002", { ask: 12000, cost: 4000 });
await db.query(`insert into public.sales(store_id,sku,qty,sold_at,price_cents,tax_cents,card_fee_cents,channel,payment_method,receipt_no)
  values('${STORE}','92002',1,now(),10000,725,268,'floor','card','0002')`);
l = await ledger("92002");
const expectProc = 0;
assert.equal(l.processing_fee_cents, expectProc);
assert.equal(l.processing_fee_source, "pending");
assert.equal(l.fees_pending, true);
assert.equal(l.profit_cents, 10000 - expectProc - 4000);
assert.equal(l.variance_cents, -2000);
console.log(`in-store card: est. processing ${expectProc}, profit ${l.profit_cents}, variance -2000 ok`);

// Reports gross includes collected tax, while profit excludes that pass-through.
// The Profit tab must show the tax deduction to reconcile its displayed rows.
const { rows: [{ report: floorReport }] } = await db.query(`
  select public.portal_channel_report(
    (now() at time zone 'America/Los_Angeles')::date,
    (now() at time zone 'America/Los_Angeles')::date + 1
  ) as report`);
const floorTotals = (typeof floorReport === 'string' ? JSON.parse(floorReport) : floorReport).channels.find(c => c.channel === 'floor');
assert.equal(floorTotals.gross_cents, 21450);
assert.equal(floorTotals.tax_collected_cents, 1450);
assert.equal(floorTotals.gross_cents - floorTotals.fee_cents - floorTotals.ship_cost_cents
  - floorTotals.processing_fee_cents - floorTotals.tax_collected_cents - floorTotals.cost_cents,
  floorTotals.profit_cents);

// 3) Website shipped: no Square estimate (pending) + Shippo label cost via web_orders.
await addUnit("92003", { ask: 8000, cost: 2000 });
await db.query(`insert into public.sales(store_id,sku,qty,sold_at,price_cents,tax_cents,card_fee_cents,shipping_cents,channel,payment_method,payment_id,receipt_no)
  values('${STORE}','92003',1,now(),8000,580,0,1200,'website','card','sqpay_web1','W0001')`);
const { rows: [{ id: webOrderId }] } = await db.query(`insert into public.web_orders(store_id,sku,sale_id,status,fulfillment,item_cents,shipping_cents,tax_cents,total_cents,payment_id,order_no,label_cost_cents)
  values('${STORE}','92003',(select id from public.sales where sku='92003'),'paid','ship',8000,1200,580,9780,'sqpay_web1','WEB-1',1399) returning id`);
l = await ledger("92003");
const expectProcWeb = 0;
assert.equal(l.processing_fee_cents, expectProcWeb);
assert.equal(l.ship_cost_cents, 1399); assert.equal(l.ship_cost_source, "shippo");
// Buyer-paid shipping is revenue; Shippo label is the cost.
assert.equal(l.shipping_cents, 1200);
assert.equal(l.profit_cents, 8000 + 1200 - expectProcWeb - 1399 - 2000);
assert.equal(l.tax_owed_cents, 580);
console.log(`website shipped: +ship-in 1200, label 1399, proc ${expectProcWeb}, profit ${l.profit_cents} ok`);

// 4) eBay: actual fee from channel_orders; a baked label guess is not a cost; tax remitted by marketplace.
await addUnit("92004", { ask: 13000, cost: 4000 });
await db.query(`insert into public.sales(store_id,sku,qty,sold_at,price_cents,tax_cents,channel,payment_method,payment_id,receipt_no)
  values('${STORE}','92004',1,now(),12999,0,'ebay','marketplace','ebay:order1','E0001')`);
await db.query(`insert into public.channel_orders(store_id,provider,order_id,sku,sale_id,item_cents,fee_cents,fee_source,baked_ship_cents,tax_cents,tax_remitted)
  values('${STORE}','ebay','order1','92004',(select id from public.sales where sku='92004'),12999,1722,'actual',1200,943,true)`);
l = await ledger("92004");
assert.equal(l.channel_fee_cents, 1722); assert.equal(l.fee_source, "actual");
assert.equal(l.ship_cost_cents, 0); assert.equal(l.ship_cost_source, "none");
assert.equal(l.profit_cents, 12999 - 1722 - 4000);
assert.equal(l.fees_pending, false);
assert.equal(l.tax_collected_cents, 943); assert.equal(l.tax_owed_cents, 0);
assert.equal(l.tax_remitted_by, "marketplace");
const { rows: [{ report: ebayReport }] } = await db.query(`
  select public.portal_channel_report(
    (now() at time zone 'America/Los_Angeles')::date,
    (now() at time zone 'America/Los_Angeles')::date + 1
  ) as report`);
const ebayTotals = (typeof ebayReport === 'string' ? JSON.parse(ebayReport) : ebayReport).channels.find(c => c.channel === 'ebay');
assert.equal(ebayTotals.tax_collected_cents, 943);
assert.equal(ebayTotals.tax_owed_cents, 0);
assert.equal(ebayTotals.gross_cents - ebayTotals.fee_cents - ebayTotals.ship_cost_cents
  - ebayTotals.processing_fee_cents - ebayTotals.tax_collected_cents - ebayTotals.cost_cents,
  ebayTotals.profit_cents);
console.log(`ebay actuals: fee 1722 ship 0 profit ${l.profit_cents}, tax remitted by marketplace ok`);

// 5) Depop via marketplace_ingest_sale: email gave real fee + prepaid label deduction.
await addUnit("92005", { ask: 8000, cost: 900 });
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`select public.marketplace_ingest_sale(
  p_store=>'${STORE}',p_sku=>'92005',p_channel=>'depop',p_price_cents=>8000,
  p_order_number=>'DEPOP-42',p_message_id=>'msg-depop-1',p_marketplace=>'depop',
  p_item_title=>'Depop unit',p_ship_by=>null,p_fulfillment=>'ship',p_buyer=>'{}'::jsonb,
  p_confidence=>1,p_fee_cents=>309,p_ship_label_cents=>999,p_tax_cents=>null,p_payout_cents=>6692)`);
await db.exec(`select set_config('request.jwt.claim.role','authenticated',false)`);
l = await ledger("92005");
assert.equal(l.channel_fee_cents, 309); assert.equal(l.fee_source, "actual");
assert.equal(l.ship_cost_cents, 999); assert.equal(l.ship_cost_source, "marketplace");
assert.equal(l.profit_cents, 8000 - 309 - 999 - 900);
console.log(`depop ingest: actual fee 309, label 999, profit ${l.profit_cents} ok`);

// 6) Mercari with no fee info → no estimate; fee pending.
await addUnit("92006", { ask: 5000, cost: 900 });
await db.query(`insert into public.sales(store_id,sku,qty,sold_at,price_cents,tax_cents,channel,payment_method,receipt_no)
  values('${STORE}','92006',1,now(),5000,0,'mercari','marketplace','MRC-9')`);
l = await ledger("92006");
assert.equal(l.channel_fee_cents, 0); assert.equal(l.fee_source, "pending");
assert.equal(l.fees_pending, true);
console.log("mercari: no fee estimate, pending ok");

// 7) Category without a recorded cost stays missing; defaults cannot create profit or payout.
await addUnit("92007", { ask: 40000, cost: null, category: "Refrigerators" });
await db.query(`insert into public.sales(store_id,sku,qty,sold_at,price_cents,tax_cents,channel,payment_method,receipt_no)
  values('${STORE}','92007',1,now(),38000,0,'facebook','marketplace','FB-1')`);
l = await ledger("92007");
assert.equal(l.cost_cents, null); assert.equal(l.cost_source, "missing");
assert.equal(l.profit_cents, null);
console.log("missing real cost: no default, profit withheld ok");

// 8) Collectible → cost locked at $0.
await addUnit("92008", { ask: 3000, cost: null, collectible: true });
await db.query(`insert into public.sales(store_id,sku,qty,sold_at,price_cents,tax_cents,channel,payment_method,receipt_no)
  values('${STORE}','92008',1,now(),3000,0,'whatnot','marketplace','WN-1')`);
l = await ledger("92008");
assert.equal(l.cost_cents, 0); assert.equal(l.cost_source, "collectible");
const whatnotFee = 0;
assert.equal(l.channel_fee_cents, whatnotFee);
assert.equal(l.profit_cents, 3000 - whatnotFee);
console.log(`collectible: $0 cost, profit ${l.profit_cents} ok`);

// 9) Voided sale still in ledger but excluded from payout/report lists.
await db.query(`update public.sales set voided_at = now() where sku = '92005'`);
l = await ledger("92005");
assert.ok(l.voided_at, "refund visible in ledger for audit");
await db.exec(`select set_config('request.jwt.claim.sub','${OWNER}',false)`);
const { rows: payoutRows } = await db.query(`select sku from public.portal_payout_sales()`);
assert.ok(!payoutRows.some((r) => r.sku === "92005"), "voided sale drops out of payouts");
assert.ok(payoutRows.some((r) => r.sku === "92006"), "live sales stay");
console.log("refund reversal: voided sale excluded from payout rows ok");

// 10) Reconciliation: estimated fee replaced by actual → profit updates.
await db.query(`insert into public.channel_orders(store_id,provider,order_id,sku,sale_id,item_cents,fee_cents,fee_source)
  values('${STORE}','mercari','MRC-1','92006',(select id from public.sales where sku='92006'),5000,0,'estimated')`);
await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
await db.query(`select public.channel_order_update('${STORE}','mercari','MRC-1',612,'actual',null,null,null,null)`);
l = await ledger("92006");
assert.equal(l.channel_fee_cents, 612); assert.equal(l.fee_source, "actual");
assert.equal(l.profit_cents, 5000 - 612 - 900);
console.log("fee reconciliation: pending → actual 612, profit recomputed ok");

await db.close();
console.log("ledger tests ok");
