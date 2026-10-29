/**
 * HISTORICAL FRESH REPLAY on PGlite — this is NOT what live has.
 *
 *   node --experimental-strip-types scripts/test-migrations.mjs
 *
 * Replays supabase/migrations minus the versions recovered from the live ledger
 * (supabase/tests/recovered-live-versions.txt) plus supabase/unapplied-legacy-migrations,
 * from an empty database. Useful to keep a from-scratch install working and to smoke-test
 * new SQL, but it cannot prove a migration is safe for live. That is
 * scripts/test-migrations-live.sh (live schema baseline + pending migrations).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { replayMigrationPaths } from "./lib/replay-migrations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stubPath = path.join(root, "supabase", "tests", "pglite-stub.sql");

async function migrationFiles() {
  return Promise.all(
    replayMigrationPaths(root).map(async (file) => ({
      name: path.basename(file),
      sql: await readFile(file, "utf8"),
    })),
  );
}

async function boot() {
  const db = new PGlite();
  await db.exec(await readFile(stubPath, "utf8"));
  return db;
}

async function apply(db, files) {
  for (const file of files) {
    try {
      await db.exec(
        file.sql.replace(/create extension if not exists pgcrypto;/gi, "-- pglite: pgcrypto stubbed"),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${file.name}: ${message}`);
    }
  }
}

async function publicItemColumns(db) {
  const { rows } = await db.query(
    `select column_name
       from information_schema.columns
      where table_schema = 'public' and table_name = 'public_items'
      order by ordinal_position`,
  );
  return rows.map((r) => r.column_name);
}

const expected = [
  "sku",
  "brand",
  "model",
  "title",
  "category",
  "condition",
  "test_status",
  "defect_notes",
  "ask_cents",
  "msrp_cents",
  "currency",
  "received_at",
  "updated_at",
  "primary_photo_path",
  "photo_paths",
  "store_id",
];

const all = await migrationFiles();
const through5 = all.filter((f) => f.name <= "0005_private_photos.sql");
const rest = all.filter((f) => f.name > "0005_private_photos.sql");

{
  const db = await boot();
  await apply(db, all);
  const cols = await publicItemColumns(db);
  assert.deepEqual(cols.slice(0, expected.length), expected, `public_items base columns: ${cols.join(",")}`);
  assert.equal(cols.includes("manufacturer_photos"), true, "fresh replay has professional photos");
  const pos = await db.query(
    `select 1 from information_schema.views where table_schema = 'public' and table_name = 'units_pos'`,
  );
  assert.equal(pos.rows.length, 1, "units_pos exists");
  const receipts = await db.query(
    `select 1 from information_schema.views where table_schema = 'public' and table_name = 'sale_receipts'`,
  );
  assert.equal(receipts.rows.length, 1, "sale_receipts exists");
  const skuStatus = await db.query(
    `select 1 from information_schema.routines where routine_schema = 'public' and routine_name = 'sku_status'`,
  );
  assert.equal(skuStatus.rows.length, 1, "sku_status exists");
  const conn = await db.query(
    `select 1 from information_schema.views where table_schema = 'public' and table_name = 'connection_status'`,
  );
  assert.equal(conn.rows.length, 1, "connection_status exists");
  const cats = await db.query(
    `select 1 from information_schema.views where table_schema = 'public' and table_name = 'public_categories'`,
  );
  assert.equal(cats.rows.length, 1, "public_categories exists");
  const addCat = await db.query(
    `select 1 from information_schema.routines where routine_schema = 'public' and routine_name = 'add_category'`,
  );
  assert.equal(addCat.rows.length, 1, "add_category exists");
  const setListing = await db.query(
    `select 1 from information_schema.routines where routine_schema = 'public' and routine_name = 'set_listing'`,
  );
  assert.equal(setListing.rows.length, 1, "set_listing exists");
  const delPhoto = await db.query(
    `select 1 from information_schema.routines where routine_schema = 'public' and routine_name = 'delete_unit_photo'`,
  );
  assert.equal(delPhoto.rows.length, 1, "delete_unit_photo exists");
  const channelOrders = await db.query(
    `select 1 from information_schema.tables where table_schema = 'public' and table_name = 'channel_orders'`,
  );
  assert.equal(channelOrders.rows.length, 1, "channel_orders exists");
  const books = await db.query(
    `select
       to_regclass('public.books_periods') is not null as periods,
       to_regclass('public.books_opening_balances') is not null as openings,
       to_regclass('public.books_inventory_snapshots') is not null as inventory_snapshots,
       to_regclass('public.books_prior_month_corrections') is not null as corrections,
       exists(select 1 from information_schema.columns where table_schema='public' and table_name='web_order_labels' and column_name='refund_received_at') as label_refund_tracking,
       exists(select 1 from information_schema.triggers where trigger_schema='public' and event_object_table='sales' and trigger_name='books_lock_guard') as sales_lock_guard`,
  );
  assert.deepEqual(books.rows[0], { periods: true, openings: true, inventory_snapshots: true, corrections: true, label_refund_tracking: true, sales_lock_guard: true }, "Books accounting schema and lock guard exist");
  const adminId = "00000000-0000-4000-8000-000000000501";
  await db.query(`insert into auth.users(id) values($1)`, [adminId]);
  const { rows: stores } = await db.query(`insert into public.stores default values returning id`);
  const storeId = stores[0].id;
  await db.query(`insert into public.staff(user_id,store_id,display_name,role) values($1,$2,'Books Admin','manager')`, [adminId, storeId]);
  await db.query(`insert into public.portal_admins(user_id,store_id) values($1,$2)`, [adminId, storeId]);
  await db.query(`select public.seed_store_settings($1,'Books Test')`, [storeId]);
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [adminId]);
  await db.query(`select set_config('request.jwt.claim.role','authenticated',false)`);
  await db.query(`alter table auth.users add column if not exists email text`);
  const nfsFields = { p_quantity: 1, p_brand: 'Acme', p_model: '', p_title: 'Acme' };
  const nfsExtras = { do_not_list: true, enrichment: { specs: { do_not_list: true } } };
  const adminReceiveId = '00000000-0000-4000-8000-000000000601';
  const { rows: nfsAdminRows } = await db.query(
    `select public.receive_commit($1, $2, ARRAY[]::text[], $3) as result`,
    [adminReceiveId, JSON.stringify(nfsFields), JSON.stringify(nfsExtras)],
  );
  const nfsAdminSku = nfsAdminRows[0].result.skus[0];
  const { rows: nfsAdminUnit } = await db.query(
    `select listing_specs->>'do_not_list' as do_not_list, show_on_website, ask_cents,
            public.unit_listing_gaps(u) as gaps
       from public.units u where store_id = $1 and sku = $2`, [storeId, nfsAdminSku],
  );
  assert.deepEqual(nfsAdminUnit[0], { do_not_list: 'true', show_on_website: false, ask_cents: null, gaps: [] },
    "admin not-for-sale Receive persists hidden with only a brand and no listing gaps");
  await db.query(`update public.units set listing_specs=listing_specs-'do_not_list' where store_id=$1 and sku=$2`, [storeId,nfsAdminSku]);
  const { rows: reenabledUnit } = await db.query(
    `select public.unit_listing_gaps(u) as gaps from public.units u where store_id=$1 and sku=$2`, [storeId,nfsAdminSku],
  );
  assert.ok(reenabledUnit[0].gaps.includes('photo') && reenabledUnit[0].gaps.includes('price'),
    "unchecking not-for-sale restores normal photo and listing requirements");
  assert.equal((await db.query(`select count(*)::int as count from public.receive_jobs where id=$1`, [adminReceiveId])).rows[0].count, 0,
    "admin not-for-sale Receive does not queue photo or listing jobs");
  await assert.rejects(
    db.query(`select public.receive_commit($1,$2,ARRAY[]::text[],$3)`, [
      '00000000-0000-4000-8000-000000000602', JSON.stringify({ ...nfsFields, p_brand: '' }), JSON.stringify(nfsExtras),
    ]),
    /Brand required/,
    "admin not-for-sale commit rejects a missing brand",
  );
  const clerkId = '00000000-0000-4000-8000-000000000502';
  await db.query(`insert into auth.users(id) values($1)`, [clerkId]);
  await db.query(`insert into public.staff(user_id,store_id,display_name,role) values($1,$2,'Clerk','staff')`, [clerkId,storeId]);
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [clerkId]);
  const clerkReceiveId = '00000000-0000-4000-8000-000000000603';
  const { rows: nfsStaffRows } = await db.query(
    `select public.receive_commit($1, $2, ARRAY[]::text[], $3) as result`,
    [clerkReceiveId, JSON.stringify(nfsFields), JSON.stringify(nfsExtras)],
  );
  const nfsStaffSku = nfsStaffRows[0].result.skus[0];
  const { rows: nfsStaffUnit } = await db.query(
    `select listing_specs->>'do_not_list' as do_not_list, show_on_website,
            public.unit_listing_gaps(u) as gaps
       from public.units u where store_id = $1 and sku = $2`, [storeId, nfsStaffSku],
  );
  assert.deepEqual(nfsStaffUnit[0], { do_not_list: 'true', show_on_website: false, gaps: [] },
    "staff not-for-sale Receive persists hidden with only a brand and no listing gaps");
  await assert.rejects(
    db.query(`select public.receive_commit($1,$2,ARRAY[]::text[],$3)`, [
      '00000000-0000-4000-8000-000000000604', JSON.stringify({ ...nfsFields, p_brand: '' }), JSON.stringify(nfsExtras),
    ]),
    /Brand required/,
    "staff not-for-sale commit rejects a missing brand",
  );
  await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [adminId]);
  await assert.rejects(
    db.query(`select public.receive_commit($1,$2,ARRAY[]::text[],'{}'::jsonb)`, [
      '00000000-0000-4000-8000-000000000605', JSON.stringify(nfsFields),
    ]),
    /unit_photo_required/,
    "for-sale receive still requires a photo server-side",
  );
  await db.query(`update public.staff set deactivated_at=now() where user_id=$1 and store_id=$2`, [clerkId,storeId]);
  console.log("not-for-sale Receive commit: admin and clerk brand-only save ok");
  const { rows: bookPeriods } = await db.query(`select public.portal_books_list('2026-01-01',null) as periods`);
  const currentPeriod = bookPeriods[0].periods.find((p) => p.period_type === "month");
  assert.ok(currentPeriod, "Books creates a draft month on first load");
  await db.query(`insert into public.sku_ledger(sku,issued_at,store_id) values('99801',now(),$1)`, [storeId]);
  const { rows: sales } = await db.query(`insert into public.sales(store_id,sku,price_cents,tax_cents,channel,sold_at,receipt_no) values($1,'99801',10000,0,'ebay',now(),'BOOKS-REPLAY-1') returning id`, [storeId]);
  await db.query(`insert into public.channel_orders(store_id,provider,order_id,sku,sale_id,item_cents,fee_cents,fee_source,payout_cents) values($1,'ebay','BOOKS-ORDER-1','99801',$2,10000,1200,'actual',8800)`, [storeId, sales[0].id]);
  await db.query(`select public.portal_books_record_platform_payout('ebay','BOOKS-PAYOUT-1',8800,(now() at time zone 'America/Los_Angeles')::date,'BANK-REF-1','test')`);
  await db.query(`select public.portal_books_link_sale_payout($1,'ebay','BOOKS-PAYOUT-1','test')`, [sales[0].id]);
  const { rows: reports } = await db.query(`select public.portal_books_report($1) as report`, [currentPeriod.id]);
  assert.equal(reports[0].report.sales.length, 1, "Books report returns sale detail");
  assert.equal(reports[0].report.payout_balances.length, 1, "Books report returns employee balance summaries");
  assert.equal(reports[0].report.money_trail[0].status, "Matched", "Books money trail connects sale, payout and bank reference");
  console.log("Books draft, sale report, payout balances and money trail ok");
  const mp = await db.query(
    `select c.relrowsecurity as rls,
            has_table_privilege('anon', 'public.manufacturer_photos', 'INSERT') as anon_insert,
            has_table_privilege('anon', 'public.manufacturer_photos', 'SELECT') as anon_select,
            has_table_privilege('authenticated', 'public.manufacturer_photos', 'UPDATE') as auth_update,
            has_table_privilege('authenticated', 'public.manufacturer_photos', 'SELECT') as auth_select
       from pg_class c where c.oid = 'public.manufacturer_photos'::regclass`,
  );
  assert.deepEqual(mp.rows[0], { rls: true, anon_insert: false, anon_select: false, auth_update: false, auth_select: true }, "manufacturer_photos locked down");
  await db.query(`select public.anon_can_read_unit_photo('not-a-path')`);
  console.log("historical fresh replay (not live): empty → latest ok");
}

{
  const db = await boot();
  await apply(db, through5);
  const before = await publicItemColumns(db);
  assert.equal(before[0], "sku", "0005 public_items still starts with sku");
  assert.equal(before.includes("store_id"), false, "0005 public_items has no store_id");
  await apply(db, rest);
  const cols = await publicItemColumns(db);
  assert.deepEqual(cols.slice(0, expected.length), expected, `upgrade public_items base columns: ${cols.join(",")}`);
  assert.equal(cols.includes("manufacturer_photos"), true, "upgrade has professional photos");
  await db.query(`select public.anon_can_read_unit_photo('not-a-path')`);
  console.log("historical fresh replay (not live): 0005 → latest upgrade ok");
}
