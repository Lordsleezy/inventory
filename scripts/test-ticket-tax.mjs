/**
 * Ticket tax allocation (0024). Runs against PGlite after migrations.
 *
 *   node --experimental-strip-types scripts/test-ticket-tax.mjs
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const stubPath = path.join(root, "supabase", "tests", "pglite-stub.sql");

async function boot() {
  const db = new PGlite();
  await db.exec(await readFile(stubPath, "utf8"));
  const names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
  for (const name of names) {
    const sql = await readFile(path.join(migrationsDir, name), "utf8");
    await db.exec(sql.replace(/create extension if not exists pgcrypto;/gi, "-- pglite stub"));
  }
  // allocate_line_taxes is revoked from public; grant to current user for tests.
  await db.exec(`grant execute on function public.allocate_line_taxes(int[], int) to public`);
  return db;
}

const db = await boot();

{
  // 200 * 725 / 10000 = 14.5 → half-up → 15
  const { rows } = await db.query(`select public.allocate_line_taxes(array[200], 725) as t`);
  assert.deepEqual(rows[0].t, [15], `half-up 14.5 → 15, got ${JSON.stringify(rows[0].t)}`);
  console.log("half-up single line ok");
}

{
  // Two lines: 1000+379=1379; 1379*725/10000 = 99.9775 → 100
  // floors: floor(1000*725/10000)=72, floor(379*725/10000)=27, rem on last → 28
  const { rows } = await db.query(`select public.allocate_line_taxes(array[1000, 379], 725) as t`);
  assert.deepEqual(rows[0].t, [72, 28], `got ${JSON.stringify(rows[0].t)}`);
  const sum = rows[0].t[0] + rows[0].t[1];
  assert.equal(sum, 100);
  console.log("two-line remainder ok");
}

{
  const { rows } = await db.query(
    `select 1 from information_schema.routines where routine_name = 'finalize_ticket'`,
  );
  assert.equal(rows.length, 1);
  console.log("finalize_ticket exists");
}

console.log("ticket tax tests ok");

// Manual register payments use finalize_ticket directly, without a reader or capture.
await db.exec(`
  insert into auth.users(id) values ('00000000-0000-0000-0000-000000000111');
  insert into public.stores(id) values ('00000000-0000-0000-0000-000000000112');
  insert into public.staff(user_id,store_id,display_name,role) values
    ('00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000112','Owner','owner');
  select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000111',false);
  select set_config('request.jwt.claim.role','authenticated',false);
  select public.seed_store_settings('00000000-0000-0000-0000-000000000112','Manual test');
  insert into public.store_settings(store_id,key,value) values
    ('00000000-0000-0000-0000-000000000112','taxRateBps','725'),
    ('00000000-0000-0000-0000-000000000112','card_fee_bps','250')
  on conflict(store_id,key) do update set value=excluded.value;
`);
for (const [method, sku, cash, expectedCard, expectedFee] of [
  ['card', '91001', 0, 10993, 268],
  ['split', '91002', 3000, 7918, 193],
]) {
  await db.query(`insert into public.sku_ledger(sku,issued_at,store_id) values ($1,now(),'00000000-0000-0000-0000-000000000112')`, [sku]);
  await db.query(`insert into public.units(sku,title,ask_cents,floor_cents,state,store_id,received_at,updated_at)
    values($1,'Manual unit',10000,100,'available','00000000-0000-0000-0000-000000000112',now(),now())`, [sku]);
  const lines = JSON.stringify([{sku,price_cents:10000}]);
  const {rows: [{q}]} = await db.query(`select public.quote_ticket_totals($1::jsonb,0,null,0,'floor',$2,$3) q`, [lines,method,cash]);
  assert.equal(q.tax_cents, 725);
  assert.equal(q.card_charge_cents, expectedCard);
  assert.equal(q.card_fee_cents, expectedFee);
  const {rows: [{id}]} = await db.query('select gen_random_uuid() id');
  const finalize = () => db.query(`select public.finalize_ticket(
    p_ticket_id=>$1::uuid,p_lines=>$2::jsonb,p_payment_method=>$3,p_payment_id=>$4,
    p_cash_cents=>$5,p_card_cents=>$6) s`, [id,lines,method,`manual:${id}`,cash,q.card_base_cents]);
  const {rows: [{s}]} = await finalize();
  assert.equal(s.total_cents, q.total_cents);
  assert.equal(s.card_cents, expectedCard);
  assert.equal(s.card_fee_cents, expectedFee);
  assert.equal(s.payment_method, method);
  const {rows: [{state}]} = await db.query('select state from public.units where sku=$1', [sku]);
  assert.equal(state, 'sold');
  assert.equal((await finalize()).rows[0].s.ticket_id, id, 'retry is idempotent');
  assert.equal((await db.query('select count(*)::int n from public.sales where ticket_id=$1', [id])).rows[0].n, 1);
  await db.query(`select public.void_ticket($1,'manual refund',null)`, [id]);
  assert.equal((await db.query('select state from public.units where sku=$1', [sku])).rows[0].state, 'available');
  assert.ok((await db.query('select voided_at from public.sales where ticket_id=$1', [id])).rows[0].voided_at);
  console.log(`manual ${method}: quote, fee, finalize, inventory, retry, void ok`);
}
assert.equal((await db.query('select count(*)::int n from public.card_charges')).rows[0].n, 0, 'manual tender never creates an integrated charge');

await db.close();
