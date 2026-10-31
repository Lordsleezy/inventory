import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = async (name: string) => readFile(path.join(root, name), 'utf8');

test('quantity control provides a scrollable 1–100 list and typed whole numbers to 999', async () => {
  const file = await source('ReceiveQuantity.tsx');
  assert.match(file, /Array\.from\(\{ length: 100 \}/);
  assert.match(file, /maximum = 999/);
  assert.match(file, /step=\{1\}/);
  assert.match(file, /Number\.isInteger/);
});

test('receive matching popup shows field differences and lets a clerk add to stocked SKUs', async () => {
  const picker = await source('ReceiveStockPicker.tsx');
  const migration = await readFile(path.resolve(root, '../../../supabase/migrations/20261201090000_receive_match_quantity_controls.sql'), 'utf8');
  assert.match(picker, /role="dialog"/);
  assert.match(picker, /No, create a new SKU/);
  assert.match(picker, /Choose this SKU/);
  assert.match(picker, /Price differs/);
  assert.match(picker, /Condition differs/);
  assert.match(picker, /No, create a new SKU/);
  assert.match(migration, /public\.portal_receive_stock_match/);
  assert.match(migration, /'location',coalesce\(loc\.locations,''\),'photo',ph\.path/);
  assert.match(migration, /u\.state in \('available','reserved','repair'\) and u\.qty_on_hand>0/);
});

test('stock quantity editor confirms admin conversion and blocks reserved-unit counts', async () => {
  const controls = await source('UnitEditDrawer.tsx');
  const migration = await readFile(path.resolve(root, '../../../supabase/migrations/20261201090000_receive_match_quantity_controls.sql'), 'utf8');
  assert.match(controls, /disabled=\{!canDelete \|\| busy \|\| Number\(quantityDraft\)>=999\}/);
  assert.match(controls, /Convert to stocked item with \$\{q\} on hand/);
  assert.match(controls, /role="dialog" aria-modal="true" aria-label="Quantity on hand"/);
  assert.match(controls, /QuantityPicker/);
  assert.match(migration, /if target<reserved then raise exception 'quantity_below_reserved:%'/);
  assert.match(migration, /Quantity edited from %s to %s/);
  assert.match(migration, /target=0 then 'available'/);
});

test('item editor stages UPC, category, listing switches, quantity, and location until its header Save', async () => {
  const controls = await source('UnitEditDrawer.tsx');
  const locationStock = await source('locationStock.ts');
  const specifics = await source('EbaySpecificsPanel.tsx');
  assert.match(controls, /upcEnrichment\.current =/);
  assert.match(controls, /if\(upcEnrichment\.current\).*portal_enrich_received_unit/s);
  assert.match(controls, /onClick=\{\(\)\s*=>\s*void save\(\)\}/);
  assert.match(controls, /window\.confirm\('Discard unsaved changes\?'\)/);
  assert.match(controls, /applySimpleLocationChange|applyPartialLocationMove/);
  assert.match(locationStock, /portal_move_location_stock/);
  assert.match(controls, /portal_unit_readiness_gaps/);
  assert.match(specifics, /pendingCategory\.current =/);
  assert.match(specifics, /Category and answers will be saved with the item/);
  assert.match(specifics, /dirtyRef\?\.current/);
});
