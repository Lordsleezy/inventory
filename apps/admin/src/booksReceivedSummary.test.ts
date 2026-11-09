import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestedItemCount, receivedInventoryCounts, receivedSheetMetrics } from './books/receivedSummary.ts';
import type { ReceivedItem } from './books/types.ts';

test('manifested total is the sum of manifest item counts', () => {
  assert.equal(manifestedItemCount([{ item_count: 120 }, { item_count: 40 }, { item_count: '8' }]), 168);
  assert.equal(manifestedItemCount(undefined), 0);
});

test('inventoried counts stay totals, and a listed plant is online', () => {
  const items = [
    { sku: '11855', qty_on_hand: 1, cost_cents: 500, unit_state: 'available', listing_status: 'ebay listed', category: 'Decor', condition: 'New' },
    { sku: '11856', qty_on_hand: 1, cost_cents: 0, unit_state: 'defective', listing_status: 'defective', category: 'Decor', condition: 'New' },
    { sku: '11857', qty_on_hand: 2, cost_cents: 300, unit_state: 'available', listing_status: 'available', category: 'Tools', condition: 'Used' },
  ] as ReceivedItem[];
  const counts = receivedInventoryCounts(items);
  assert.equal(counts.skus, 3);
  assert.equal(counts.units, 4);
  assert.equal(counts.online_units, 1);
  assert.equal(counts.defective_units, 1);
  assert.equal(counts.not_listed_units, 2);
  assert.equal(counts.missing_cost_units, 1);
  assert.deepEqual(counts.channels, [{ channel: 'ebay', units: 1 }]);
});

test('the spreadsheet row under items inventoried is the manifested total', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({ sku: String(11000 + i), qty_on_hand: 1, cost_cents: 100 })) as ReceivedItem[];
  const rows = receivedSheetMetrics(items, 316);
  assert.equal(rows[0].label, 'Items inventoried');
  assert.equal(rows[0].count, 40);
  assert.equal(rows[1].label, 'Manifested');
  assert.equal(rows[1].count, 316);
  assert.equal(rows.some((row) => String(row.label).includes('11000')), false);
  assert.equal(rows.length < 15, true);
});
