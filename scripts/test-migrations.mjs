/**
 * Apply Floor migrations on PGlite.
 *
 *   node --experimental-strip-types scripts/test-migrations.mjs
 *
 * Covers a fresh 0001→latest run and an upgrade that already has 0005.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const stubPath = path.join(root, "supabase", "tests", "pglite-stub.sql");

async function migrationFiles() {
  const names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(migrationsDir, name), "utf8"),
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
  assert.deepEqual(cols, expected, `fresh 0001→0010 columns: ${cols.join(",")}`);
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
  await db.query(`select public.anon_can_read_unit_photo('not-a-path')`);
  console.log("fresh 0001→0011 ok");
}

{
  const db = await boot();
  await apply(db, through5);
  const before = await publicItemColumns(db);
  assert.equal(before[0], "sku", "0005 public_items still starts with sku");
  assert.equal(before.includes("store_id"), false, "0005 public_items has no store_id");
  await apply(db, rest);
  const cols = await publicItemColumns(db);
  assert.deepEqual(cols, expected, `upgrade 0005→0010 columns: ${cols.join(",")}`);
  await db.query(`select public.anon_can_read_unit_photo('not-a-path')`);
  console.log("upgrade 0005→0011 ok");
}
