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
