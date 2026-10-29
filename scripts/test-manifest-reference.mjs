import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { replayMigrationPaths } from './lib/replay-migrations.mjs';
import { parseManifestLines } from '../apps/admin/src/manifestLines.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = parseManifestLines(await readFile(new URL('../apps/admin/test-fixtures/bstock.csv', import.meta.url), 'utf8'));
const receiveFixture = parseManifestLines(await readFile(new URL('../apps/admin/test-fixtures/manifest-receive-upcs.csv', import.meta.url), 'utf8'));
const store = '10000000-0000-0000-0000-000000000001';
const otherStore = '10000000-0000-0000-0000-000000000002';
const admin = '20000000-0000-0000-0000-000000000001';
const clerk = '20000000-0000-0000-0000-000000000002';
const outsider = '20000000-0000-0000-0000-000000000003';
const id = '30000000-0000-0000-0000-000000000001';
const newerId = '30000000-0000-0000-0000-000000000002';
const oldId = '30000000-0000-0000-0000-000000000003';
const receiveFixtureId = '30000000-0000-0000-0000-000000000004';

test('manifest upload, lookup, store isolation, and server permissions', { timeout: 120000 }, async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('../supabase/tests/pglite-stub.sql', import.meta.url), 'utf8'));
    for (const file of replayMigrationPaths(root)) {
      if (file.endsWith('20261116120000_manifest_receive_reference.sql')) {
        // Live's storage policies can differ from the historical replay.
        await db.exec('drop policy if exists floor_manifests_read on storage.objects; drop policy if exists floor_manifests_upload on storage.objects');
      }
      try { await db.exec((await readFile(file, 'utf8')).replace(/create extension if not exists pgcrypto;/gi, '-- stub')); }
      catch (error) { throw new Error(`${file}: ${error.message}`); }
    }
    await db.query('insert into public.stores(id) values ($1),($2)', [store, otherStore]);
    await db.query('insert into auth.users(id) values ($1),($2),($3)', [admin, clerk, outsider]);
    await db.query(`insert into public.staff(user_id,store_id,display_name,role) values ($1,$4,'Admin','owner'),($2,$4,'Jacob','staff'),($3,$5,'Other','staff')`, [admin, clerk, outsider, store, otherStore]);
    await db.query('insert into public.portal_admins(user_id,store_id) values ($1,$2)', [admin,store]);
    async function login(user) {
      await db.exec('reset role');
      await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [user]);
      await db.query(`select set_config('request.jwt.claim.role','authenticated',false)`);
      await db.exec('set role authenticated');
    }
    const ref = async code => (await db.query('select public.portal_manifest_receive_reference($1) as value', [code])).rows[0].value;
    async function create(manifestId, lines, date = '2026-10-28', name = 'Oct 28 B-Stock load') {
      return db.query(`select public.portal_create_manifest_with_lines($1,$2,'B-Stock',$3,$4,'spreadsheet',$5,'text/csv',1000,$6::jsonb)`,
        [manifestId, name, date, lines.reduce((sum, l) => sum + l.qty, 0), `${store}/${manifestId}/load.csv`, JSON.stringify(lines)]);
    }
    await login(admin);
    await create(id, fixture);
    let rows = (await db.query('select * from public.manifest_lines order by line_number')).rows;
    assert.equal(rows.length, 3);
    assert.equal(rows[2].upc_raw, '096801681609');
    assert.equal(rows[2].description, '22" Velvet Border Pillow');
    assert.equal(rows[0].unit_retail_cents, 4999);
    assert.equal(rows[0].tcin, '94688426');
    assert.equal(rows[0].pallet_id, 'PTBP40668');
    assert.equal(rows[0].lot_id, fixture[0].lot_id);
    assert.equal((await ref('199268613418')).retail_cents, 4999);
    assert.equal(await ref('999999999999'), null);
    assert.equal((await ref('0096801681609')).warnings[0].defective_qty, 2);
    assert.deepEqual((await ref('00096801681609')).warnings[0].conditions, ['SALVAGE']);
    // Old condition warnings survive a newer retail source, with denominators scoped to each load.
    await create(newerId, [ { ...fixture[2], qty: 12, unit_retail_cents: 3000, condition: 'NEW' }, { ...fixture[2], qty: 2, unit_retail_cents: 3000 } ], '2026-10-29', 'New load');
    const mixed = await ref('096801681609');
    assert.equal(mixed.retail_cents, 3000);
    assert.equal(mixed.manifest_name, 'New load');
    assert.equal(mixed.warnings[0].total_qty, 14);
    assert.equal(mixed.warnings[0].defective_qty, 2);
    assert.equal(mixed.warnings.length, 2);
    assert.equal((await ref('199268613418')).warnings.length, 0);
    // Import is idempotent; backfilling a prior file cannot erase/reprice already imported lines.
    await db.query('select public.portal_import_manifest_lines($1,$2::jsonb)', [id, JSON.stringify([{ ...fixture[0], unit_retail_cents: 1 }])]);
    assert.equal((await ref('199268613418')).retail_cents, 4999);
    await assert.rejects(create(oldId, [{ ...fixture[0], upc_raw: 199268613418 }]), /text UPC/);
    assert.equal((await db.query('select id from public.store_manifests where id=$1',[oldId])).rows.length, 0, 'failed import rolls back parent manifest');
    await create(oldId, [{ ...fixture[0], upc_raw: '491234567890', condition: 'NEW' }], '2026-10-01');
    assert.equal((await ref('0491234567890')).retail_cents, 4999);
    for (const condition of ['SALVAGE','DAMAGED','DEFECTIVE','FOR_PARTS','NOT_WORKING','For parts / not working','Non-functional','broken']) {
      assert.equal((await db.query('select public.manifest_condition_defective($1) as yes',[condition])).rows[0].yes, true, condition);
    }
    for (const condition of ['NEW','LIKE_NEW','USED_GOOD','UNDAMAGED']) {
      assert.equal((await db.query('select public.manifest_condition_defective($1) as yes',[condition])).rows[0].yes, false, condition);
    }
    await create(receiveFixtureId, receiveFixture, '2026-10-30', 'B-Stock UPC coverage');
    for (const [upc, cents] of [['199268613418',4999],['096801681609',9899],['810180401883',4999],['493240033691',3999]]) {
      assert.equal((await ref(upc)).retail_cents, cents, `admin retail for ${upc}`);
    }
    assert.equal((await ref('0096801681609')).retail_cents, 9899, 'leading-zero UPC-A matches as admin');
    assert.equal((await ref('810180401883')).warnings[0].conditions[0], 'SALVAGE', 'admin sees Pura warning');
    assert.equal((await ref('493240033691')).retail_cents, 3999, '49-prefix sticker UPC matches as admin');
    const list = (await db.query('select public.portal_manifest_list() as value')).rows[0].value;
    assert.equal(list.find(m => m.id === id).line_count, 3);
    assert.equal(list.find(m => m.id === receiveFixtureId).line_count, receiveFixture.length);
    await db.exec('reset role');
    await db.query(`insert into storage.objects(bucket_id,name) values ('floor-manifests',$1)`,[`${store}/${id}/load.csv`]);
    await login(clerk);
    const clerkReference = await ref('096801681609');
    assert.equal(clerkReference.retail_cents, 9899);
    assert.equal(clerkReference.warnings[0].defective_qty, 2);
    for (const [upc, cents] of [['199268613418',4999],['096801681609',9899],['810180401883',4999],['493240033691',3999]]) {
      assert.equal((await ref(upc)).retail_cents, cents, `clerk retail for ${upc}`);
    }
    assert.equal((await ref('0096801681609')).retail_cents, 9899, 'leading-zero UPC-A matches for clerk');
    assert.equal((await ref('810180401883')).warnings[0].conditions[0], 'SALVAGE', 'clerk sees Pura warning');
    assert.equal((await ref('493240033691')).retail_cents, 3999, '49-prefix sticker UPC matches for clerk');
    assert.deepEqual(Object.keys(clerkReference).sort(), ['expected','manifest_name','manifest_on','received','retail_cents','warnings']);
    assert.doesNotMatch(JSON.stringify(clerkReference), /cost|profit|pallet|lot_id|description|brand|tcin/i);
    assert.equal((await db.query('select * from public.store_manifests')).rows.length, 0);
    assert.equal((await db.query('select * from public.manifest_lines')).rows.length, 0);
    // Grant storage select in the stub so the real policy, rather than missing table privilege, is exercised.
    await db.exec('reset role; grant usage on schema storage to authenticated; grant select, insert on storage.objects to authenticated; set role authenticated');
    assert.equal((await db.query("select * from storage.objects where bucket_id='floor-manifests'")).rows.length, 0);
    await assert.rejects(db.query('select public.portal_manifest_list()'), /portal_access_denied/);
    await assert.rejects(db.query('select public.portal_set_manifest_count($1,10)', [id]), /portal_access_denied/);
    await assert.rejects(db.query('select public.portal_import_manifest_lines($1,$2::jsonb)', [id, JSON.stringify(fixture)]), /portal_access_denied/);
    await assert.rejects(create('30000000-0000-0000-0000-000000000009',fixture), /portal_access_denied/);
    await assert.rejects(db.query('select public.staff_receive_unit(p_cost_cents => 100)'), /not_manager/);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values ('floor-manifests',$1)", [`${store}/clerk.csv`]), /row-level security/);
    await login(outsider);
    assert.equal(await ref('096801681609'), null);
    await db.exec('reset role');
    await db.query('update public.staff set store_id=$1 where user_id=$2', [otherStore,admin]);
    await login(admin);
    assert.equal((await ref('096801681609')).retail_cents, 9899, 'admin reference uses the portal store, matching Receive');
    await login('');
    await assert.rejects(ref('096801681609'), /staff_access_denied/);
    // Read-only lookup creates no units and changes no item prices, costs, or conditions.
    await db.exec('reset role');
    assert.equal((await db.query('select count(*)::int as n from public.units')).rows[0].n, 0);
    const index = await db.query("select indexname from pg_indexes where tablename='manifest_lines' and indexname='manifest_lines_upc_idx'");
    assert.equal(index.rows.length, 1);
  } finally { await db.close(); }
});
