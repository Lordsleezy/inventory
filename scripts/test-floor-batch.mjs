import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { replayMigrationPaths } from "./lib/replay-migrations.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const db = new PGlite();
await db.exec(await readFile(new URL("../supabase/tests/pglite-stub.sql", import.meta.url), "utf8"));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of replayMigrationPaths(root)) {
  const sql = (await readFile(file, "utf8"))
    .replace(/create extension if not exists pgcrypto;/gi, "-- pglite: pgcrypto stubbed");
  try { await db.exec(sql); }
  catch (error) { throw new Error(`${file}: ${error.message}`); }
}

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const store = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
await db.query("insert into auth.users(id) values($1)", [owner]);
await db.query("insert into public.stores(id) values($1)", [store]);
await db.query("insert into public.portal_admins(user_id,store_id) values($1,$2)", [owner, store]);
await db.query("insert into public.staff(user_id,store_id,display_name,role) values($1,$2,'Owner','owner')", [owner, store]);
await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);

const saved = await db.query(
  "select public.portal_save_withdrawal(null,'safe',1250,current_date,'person_payout','cash to owner',$1) id", [owner]);
const withdrawal = saved.rows[0].id;
let payments = await db.query("select amount_cents,voided_at from public.portal_payout_payments where withdrawal_id=$1", [withdrawal]);
assert.equal(payments.rows.length, 1);
assert.equal(payments.rows[0].amount_cents, 1250);
await db.query("select public.portal_save_withdrawal($1,'safe',1500,current_date,'person_payout','edited',$2)", [withdrawal, owner]);
payments = await db.query("select amount_cents from public.portal_payout_payments where withdrawal_id=$1", [withdrawal]);
assert.equal(payments.rows[0].amount_cents, 1500);
await db.query("select public.portal_void_withdrawal($1,'safe')", [withdrawal]);
payments = await db.query("select voided_at from public.portal_payout_payments where withdrawal_id=$1", [withdrawal]);
assert.ok(payments.rows[0].voided_at);
const audit = await db.query("select action from public.withdrawal_audit where withdrawal_id=$1 order by id", [withdrawal]);
assert.deepEqual(audit.rows.map((row) => row.action), ["create", "edit", "void"]);

await db.query("insert into public.sku_ledger(sku,store_id,issued_at) values('12345',$1,now())", [store]);
await db.query(
  "insert into public.units(sku,store_id,received_at,updated_at,qty_on_hand) values('12345',$1,now(),now(),3)", [store]);
await db.query("select public.portal_set_bay(14,array[3,3,3,0])");
await db.query("select public.portal_move_location_stock('12345','14-2-3',2,null)");
let allocated = await db.query("select quantity from public.unit_location_stock where sku='12345'");
assert.equal(allocated.rows[0].quantity, 2);
await db.query("update public.units set qty_on_hand=2 where sku='12345'");
allocated = await db.query("select quantity from public.unit_location_stock where sku='12345'");
assert.equal(allocated.rows[0].quantity, 1);

const manifest = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
await db.query(
  "select public.portal_create_manifest($1,'Load 1','Vendor',current_date,3,'manual',$2,'application/pdf',123)",
  [manifest, `${store}/${manifest}/load.pdf`]);
await db.query("select public.portal_tag_manifest($1,array['12345'])", [manifest]);
const list = await db.query("select public.portal_manifest_list() result");
assert.equal(list.rows[0].result[0].received_count, 2);

await db.query("select public.portal_insights('month')");
await db.query("select public.portal_withdrawal_reconciliation()");
console.log("withdrawals, payout link/audit, manifests, locations and insights RPCs ok");
