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
  const stockedReceiveId = '00000000-0000-4000-8000-000000000606';
  await db.query(`insert into public.store_bays(store_id,bay_no,row_bins) values($1,1,ARRAY[3,3,3])`, [storeId]);
  await db.query(`insert into public.store_locations(store_id,code,bay_no,row_no) values($1,'1-1',1,1)`, [storeId]);
  const stockedFields = { ...nfsFields, p_quantity: 12, p_title: 'Acme Holiday Lights', p_ask: 2500 };
  const stockedExtras = { ...nfsExtras, location: '1-1' };
  const receivedBeforeStock = (await db.query(`select public.portal_inventory_received_total() as total`)).rows[0].total;
  const { rows: stockedRows } = await db.query(
    `select public.portal_receive_stocked_commit($1,$2,ARRAY[]::text[],$3) as result`,
    [stockedReceiveId, JSON.stringify(stockedFields), JSON.stringify(stockedExtras)],
  );
  assert.equal(stockedRows[0].result.skus.length, 1, 'multi-quantity receive issues one SKU');
  const stockedSku = stockedRows[0].result.skus[0];
  const { rows: stockBalance } = await db.query(
    `select u.qty_on_hand,u.is_stocked,(select coalesce(sum(m.quantity_delta),0)::int from public.stock_movements m where m.store_id=u.store_id and m.sku=u.sku) movement_balance
       from public.units u where u.store_id=$1 and u.sku=$2`, [storeId, stockedSku],
  );
  assert.deepEqual(stockBalance[0], { qty_on_hand: 12, is_stocked: true, movement_balance: 12 },
    'one stocked SKU carries its quantity and matches the movement ledger');
  assert.equal((await db.query(`select public.portal_inventory_received_total() as total`)).rows[0].total - receivedBeforeStock, 12,
    'all-time inventoried total counts stocked receive quantity, not SKU rows');
  assert.equal((await db.query(`select quantity from public.unit_location_stock where store_id=$1 and sku=$2 and location_code='1-1'`, [storeId,stockedSku])).rows[0].quantity, 12,
    'stocked receive assigns the full quantity to its selected location');
  const { rows: replayedStock } = await db.query(
    `select public.portal_receive_stocked_commit($1,$2,ARRAY[]::text[],$3) as result`,
    [stockedReceiveId, JSON.stringify(stockedFields), JSON.stringify(stockedExtras)],
  );
  assert.equal(replayedStock[0].result.skus.length, 1, 'replayed multi-quantity receive keeps one SKU');
  const { rows: stockMatches } = await db.query(
    `select public.portal_receive_stock_match(null,'Acme Holiday Lights',9999,'Used') as matches`,
  );
  assert.ok(stockMatches[0].matches.some((match) => match.sku === stockedSku && match.is_stocked),
    'exact no-UPC title lookup finds the existing stocked SKU');
  assert.ok(stockMatches[0].matches.some((match) => match.sku === stockedSku && match.price_diff && match.condition_diff),
    'receive matcher retains identity matches when price and condition differ');
  const stockAddRequest = '00000000-0000-4000-8000-000000000607';
  await db.query(`select public.portal_stock_receive_add($1,$2,2,null)`, [stockAddRequest, stockedSku]);
  const { rows: stockAddReplay } = await db.query(`select public.portal_stock_receive_add($1,$2,2,null) as result`, [stockAddRequest, stockedSku]);
  assert.equal(stockAddReplay[0].result.replayed, true, 'replayed receive-to-stock request does not add quantity twice');
  assert.equal((await db.query(`select qty_on_hand from public.units where store_id=$1 and sku=$2`, [storeId,stockedSku])).rows[0].qty_on_hand, 14,
    'existing-stock receive commits once');
  assert.equal((await db.query(`select public.portal_inventory_received_total() as total`)).rows[0].total - receivedBeforeStock, 14,
    'all-time inventoried total adds quantities received into an existing stocked SKU');
  await db.query(`update public.units set qty_on_hand=qty_on_hand-3,state='available' where store_id=$1 and sku=$2`, [storeId,stockedSku]);
  const { rows: stockSale } = await db.query(
    `insert into public.sales(store_id,sku,price_cents,tax_cents,channel,sold_at,receipt_no,qty)
     values($1,$2,3000,0,'floor',now(),'STOCK-RECEIPT-1',3) returning id`, [storeId,stockedSku],
  );
  assert.equal((await db.query(`select movement_type from public.stock_movements where store_id=$1 and sku=$2 order by id desc limit 1`, [storeId,stockedSku])).rows[0].movement_type, 'sold',
    'register sales label the quantity movement with its sale');
  await db.query(`select public.return_reverse_sale($1,$2,'test return',true)`, [storeId,stockSale[0].id]);
  assert.equal((await db.query(`select qty_on_hand from public.units where store_id=$1 and sku=$2`, [storeId,stockedSku])).rows[0].qty_on_hand, 14,
    'full sale reversal restores the recorded quantity');
  assert.equal((await db.query(`select movement_type from public.stock_movements where store_id=$1 and sku=$2 order by id desc limit 1`, [storeId,stockedSku])).rows[0].movement_type, 'returned',
    'sale reversal is recorded as a return movement');
  assert.equal((await db.query(`select public.portal_inventory_received_total() as total`)).rows[0].total - receivedBeforeStock, 14,
    'sales and returns do not change the historical received total');
  await db.query(`select public.portal_stock_add($1,3,250)`, [stockedSku]);
  assert.equal((await db.query(`select qty_on_hand from public.units where store_id=$1 and sku=$2`, [storeId,stockedSku])).rows[0].qty_on_hand, 17,
    'stock add updates on-hand atomically');
  assert.equal((await db.query(`select public.portal_inventory_received_total() as total`)).rows[0].total - receivedBeforeStock, 17,
    'all-time inventoried total includes stock added after receipt');
  assert.equal(Number((await db.query(`select public.channel_available_qty($1,$2) as q`, [storeId, stockedSku])).rows[0].q), 17,
    'channel available quantity equals on-hand when nothing is held');
  const mattressRule = String.raw`\mmattress(es)?\M(?!\s+(pads?|toppers?|protectors?))`;
  assert.equal((await db.query(`select count(*)::int as n from public.listing_never_rules where note='Mattresses' and value = $1`, [String.raw`\mmattress(es)?\M`])).rows[0].n, 0,
    'the mattress never-list rule no longer treats every mattress word as a mattress');
  for (const title of ['Queen mattress pad', 'mattress topper', 'mattress protector']) {
    assert.equal((await db.query(`select $1 ~* $2 as blocked`, [title, mattressRule])).rows[0].blocked, false, `${title} is not a never-list mattress`);
  }
  assert.equal((await db.query(`select $1 ~* $2 as blocked`, ['Queen mattress', mattressRule])).rows[0].blocked, true,
    'an actual mattress stays never-list');
  await db.query(`update public.units set show_on_website=true where store_id=$1 and sku=$2`, [storeId, stockedSku]);
  assert.equal((await db.query(`select public.portal_stock_adjust($1,'set',13,'count_correction')`, [stockedSku])).rows[0].portal_stock_adjust, 13,
    'count correction can set a non-negative balance');
  const setHistory = (await db.query(`select public.portal_stock_history($1) history`, [stockedSku])).rows[0].history;
  assert.equal(setHistory[0].reason, 'Quantity edited from 17 to 13', 'count changes record the exact before/after movement reason');
  assert.equal(setHistory[0].actor, 'Books Admin', 'count changes record the editor');
  const { rows: reservation } = await db.query(
    `insert into public.reservations(store_id,sku,channel,expires_at) values($1,$2,'test',now()+interval '1 hour') returning id`,
    [storeId, stockedSku],
  );
  await assert.rejects(db.query(`select public.portal_stock_adjust($1,'set',0,'count_correction')`, [stockedSku]), /quantity_below_reserved/,
    'count cannot be lowered below a live reservation');
  await db.query(`update public.reservations set released_at=now() where id=$1`, [reservation[0].id]);
  await db.query(`select public.portal_stock_adjust($1,'set',0,'count_correction')`, [stockedSku]);
  const { rows: zeroCount } = await db.query(`select qty_on_hand,state from public.units where store_id=$1 and sku=$2`, [storeId, stockedSku]);
  assert.deepEqual(zeroCount[0], { qty_on_hand: 0, state: 'available' }, 'zero quantity remains available/out-of-stock rather than sold');
  assert.equal((await db.query(`select show_on_website from public.units where store_id=$1 and sku=$2`, [storeId, stockedSku])).rows[0].show_on_website, false,
    'zero stock hides the website listing');
  await db.query(`select public.portal_stock_adjust($1,'set',13,'count_correction')`, [stockedSku]);
  await db.query(`update public.unit_location_stock set quantity=12 where store_id=$1 and sku=$2 and location_code='1-1'`, [storeId,stockedSku]);
  await assert.rejects(db.query(`select public.portal_stock_adjust($1,'set',-1,'count_correction')`, [stockedSku]), /stock_cannot_be_negative/,
    'stock adjustment refuses negative on-hand');
  assert.equal((await db.query(`select coalesce(sum(quantity_delta),0)::int balance from public.stock_movements where store_id=$1 and sku=$2`, [storeId,stockedSku])).rows[0].balance, 13,
    'movement ledger remains equal to on-hand after add and adjustment');
  const giveawayResult = (await db.query(`select public.portal_stock_giveaway($1,2,'Jacob','test') result`, [stockedSku])).rows[0].result;
  assert.equal(giveawayResult.total_cost_cents, 500, 'stock giveaway posts quantity times the real per-unit cost');
  assert.equal((await db.query(`select amount_cents from public.portal_expenses where id=$1`, [giveawayResult.expense_id])).rows[0].amount_cents, 500,
    'stock giveaway expense reaches the Giveaways ledger');
  const defectiveSku = (await db.query(`select public.portal_stock_pull_defective($1) sku`, [stockedSku])).rows[0].sku;
  assert.ok(defectiveSku && defectiveSku !== stockedSku, 'defective pull issues a new one-of-one SKU');
  const { rows: pulledUnit } = await db.query(`select state,condition,is_stocked,qty_on_hand,show_on_website,listing_specs->>'do_not_list' do_not_list from public.units where store_id=$1 and sku=$2`, [storeId,defectiveSku]);
  assert.deepEqual(pulledUnit[0], { state: 'available', condition: 'Defective', is_stocked: false, qty_on_hand: 1, show_on_website: false, do_not_list: 'true' },
    'pulled unit is a hidden, defective, one-of-one record');
  assert.equal((await db.query(`select public.portal_inventory_received_total() as total`)).rows[0].total - receivedBeforeStock, 17,
    'pulling a defective unit transfers it without double-counting it as newly received');
  assert.equal((await db.query(`select qty_on_hand from public.units where store_id=$1 and sku=$2`, [storeId,stockedSku])).rows[0].qty_on_hand, 10,
    'giveaway and defective pull subtract from stocked on-hand');
  assert.equal((await db.query(`select coalesce(sum(quantity_delta),0)::int balance from public.stock_movements where store_id=$1 and sku=$2`, [storeId,stockedSku])).rows[0].balance, 10,
    'giveaway and defective pull preserve the movement balance invariant');
  assert.equal((await db.query(`select coalesce(sum(quantity),0)::int quantity from public.unit_location_stock where store_id=$1 and sku=$2 and location_code='1-1'`, [storeId,stockedSku])).rows[0].quantity, 0,
    'giveaway and defective pull keep source location allocations in sync');
  assert.equal((await db.query(`select coalesce(sum(quantity),0)::int quantity from public.unit_location_stock where store_id=$1 and sku=$2 and location_code='1-1'`, [storeId,defectiveSku])).rows[0].quantity, 0,
    'defective pull assigns the moved unit to its new SKU at the same location');
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
  await db.query(`insert into public.channel_taxonomy(channel,category_id,path,leaf,active,version) values
    ('ebay','100','Root > Home & Garden > Home Décor > Frames',true,true,'test'),
    ('ebay','200','Root > Baby > Nursery Décor > Picture Frames',true,true,'test'),
    ('ebay','201','Root > Collectibles > Animals > Fish > Dolphins > Picture Frames',true,true,'test'),
    ('ebay','300','Root > Home & Garden > Home Décor > Candles & Candle Holders',true,true,'test'),
    ('ebay','301','Root > Collectibles > Animals > Fish > Dolphins > Candles & Candleholders',true,true,'test')`);
  const { rows: frameSearch } = await db.query(`select public.portal_category_search('ebay','Picture frame',60) as results`);
  assert.equal(frameSearch[0].results[0].category_id, '100', 'picture-frame search ranks the Home & Garden Frames path first');
  assert.ok(frameSearch[0].results.some((row) => row.category_id === '201'), 'niche matching categories remain available lower in the results');
  const { rows: candleSearch } = await db.query(`select public.portal_category_search('ebay','Holiday candle',3) as results`);
  assert.equal(candleSearch[0].results[0].category_id, '300', 'mainstream Home & Garden candle category ranks ahead of collectible niches');
  const { rows: directCategory } = await db.query(`select public.portal_category_search('ebay','100',3) as results`);
  assert.equal(directCategory[0].results[0].path, 'Root > Home & Garden > Home Décor > Frames', 'category search accepts a pasted eBay category ID');
  console.log("eBay category search synonyms, mainstream ranking and direct IDs ok");
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
