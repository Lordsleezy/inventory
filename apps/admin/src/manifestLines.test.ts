import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseManifestLines, normalizeManifestUpc } from './manifestLines.ts';
import { parseManifestCsv } from './manifestCount.ts';
import { manifestDefectWarnings } from './manifestReference.ts';
import { backfillManifestFiles } from './manifestBackfill.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
const fixture = readFileSync(new URL('../test-fixtures/bstock.csv', import.meta.url), 'utf8');

test('B-Stock fixture preserves every line, text UPCs, cents, and CSV escapes', () => {
  const lines = parseManifestLines(fixture);
  assert.equal(lines.length, 3);
  assert.equal(lines.reduce((sum, line) => sum + line.qty, 0), 15);
  assert.equal(lines[0].unit_retail_cents, 4999);
  assert.equal(lines[0].tcin, '94688426');
  assert.equal(lines[0].pallet_id, 'PTBP40668');
  assert.equal(lines[0].lot_id, 'irc_mixed_20261007_067_p');
  assert.equal(lines[2].upc_raw, '096801681609');
  assert.equal(lines[2].upc_normalized, '096801681609');
  assert.equal(lines[2].description, '22" Velvet Border Pillow');
  assert.equal(lines[2].condition, 'SALVAGE');
  const rows = parseManifestCsv(fixture);
  assert.equal(rows[2][9], 'Türkiye');
  assert.equal(rows[1][12], 'HOME DÉCOR QSR326');
});

test('header mapping is independent of position and required columns are explicit', () => {
  assert.equal(parseManifestLines('Condition,Unit Retail,Qty,UPC\nNEW,0,1,096801681609')[0].unit_retail_cents, 0);
  assert.throws(() => parseManifestLines('UPC,Qty\n096801681609,1'), /Unit Retail, Condition/);
  assert.throws(() => parseManifestLines('UPC,Qty,Unit Retail,Condition\n096801681609,1.5,20,NEW'), /Qty/);
  assert.throws(() => parseManifestLines('UPC,Qty,Unit Retail,Condition\n096801681609,1,20.001,NEW'), /Unit Retail/);
  assert.throws(() => parseManifestLines('UPC,Qty,Unit Retail,Condition\n"096801681609,1,20,NEW'), /Unclosed/);
});

test('normalization preserves significant leading zeros and Target 49 stickers', () => {
  for (const code of ['096801681609', '0096801681609', '00096801681609']) assert.equal(normalizeManifestUpc(code), '096801681609');
  assert.equal(normalizeManifestUpc('0491234567890'), '491234567890');
  assert.equal(normalizeManifestUpc('491234567890'), '491234567890');
  assert.equal(normalizeManifestUpc('199268613418'), '199268613418');
  assert.equal(normalizeManifestUpc('1.99268613418e11'), '');
});

test('defect warnings describe all-defective and mixed-condition quantities', () => {
  const ref = { retail_cents: 4999, manifest_name: 'Load', manifest_on: '2026-10-28', warnings: [
    { manifest_name: 'Load', total_qty: 14, defective_qty: 2, conditions: ['SALVAGE'] },
    { manifest_name: 'Old load', total_qty: 1, defective_qty: 1, conditions: ['NOT_WORKING'] },
  ] };
  assert.equal(manifestDefectWarnings(ref)[0], '2 of 14 units of this UPC on the manifest are marked SALVAGE. Check this one.');
  assert.equal(manifestDefectWarnings(ref)[1], 'Manifest warns an item with this UPC is defective (NOT_WORKING).');
});

test('existing CSV files backfill in place; imported lines and originals are not overwritten', async () => {
  const downloads: string[] = [];
  const imports: unknown[] = [];
  const client = {
    storage: { from: () => ({ download: async (path: string) => {
      downloads.push(path);
      return path.includes('missing') ? { error: new Error('missing') } : { data: new Blob([fixture]) };
    } }) },
    rpc: async (name: string, args: { p_lines: unknown[] }) => { assert.equal(name, 'portal_import_manifest_lines'); imports.push(args); return { data: args.p_lines.length }; },
  } as unknown as SupabaseClient;
  const states = await backfillManifestFiles(client, [
    { id: 'a', name: 'Load', storage_path: 'a.csv', line_count: 0 },
    { id: 'b', name: 'Already saved', storage_path: 'b.csv', line_count: 174 },
    { id: 'c', name: 'Missing file', storage_path: 'missing.csv', line_count: 0 },
    { id: 'd', name: 'PDF', storage_path: 'd.pdf', line_count: 0 },
  ]);
  assert.deepEqual(downloads, ['a.csv', 'missing.csv']);
  assert.equal(imports.length, 1);
  assert.match(states.a, /3 lines saved/);
  assert.match(states.c, /re-upload/);
});
