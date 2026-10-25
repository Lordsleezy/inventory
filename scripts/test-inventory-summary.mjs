import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { replayMigrationPaths } from './lib/replay-migrations.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite();
await db.exec(await readFile(path.join(root, 'supabase/tests/pglite-stub.sql'), 'utf8'));
for (const file of replayMigrationPaths(root)) {
  const sql = (await readFile(file, 'utf8')).replace(/create extension if not exists pgcrypto;/gi, '-- pglite: pgcrypto stubbed');
  try { await db.exec(sql); } catch (error) { throw new Error(`${path.basename(file)}: ${error.message}`); }
}
const tap = await readFile(path.join(root, 'supabase/tests/pgtap/013_inventory_unit_summary.sql'), 'utf8');
const fixture = tap.match(/do \$\$[\s\S]*?end \$\$;/)?.[0];
assert.ok(fixture, 'pgTAP fixture found');
await db.exec(fixture.replaceAll('v_owner::text,true', 'v_owner::text,false').replaceAll('v_clerk::text,true', 'v_clerk::text,false'));
await db.exec("select set_config('request.jwt.claim.role','authenticated',false)");
async function summary(user) {
  await db.exec(`select set_config('request.jwt.claim.sub',current_setting('test.${user}'),false)`);
  const { rows } = await db.query('select public.portal_inventory_unit_summary() as counts');
  return rows[0].counts;
}
const owner = await summary('owner');
assert.deepEqual(owner, { total: 33, listed: 24, not_listed: 3, defective: 6 });
assert.equal(owner.listed + owner.not_listed + owner.defective, owner.total);
assert.deepEqual(await summary('clerk'), owner, 'clerk receives only the same four unit counts');
console.log('inventory unit summary: 7 assertions passed');
await db.close();
