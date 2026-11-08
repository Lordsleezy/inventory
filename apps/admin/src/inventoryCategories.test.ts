import test from 'node:test';
import assert from 'node:assert/strict';
import { rollupRareCategories } from './books/inventoryCategories.ts';

test('a category with one unit rolls into Other', () => {
  const rows = rollupRareCategories([
    { category: 'Kitchen', units: 8, cost_cents: 8000, floor_cents: 12000, sold_units: 2, sell_through: 20 },
    { category: 'Brass candelabra', units: 1, cost_cents: 500, floor_cents: 900, sold_units: 0, sell_through: 0 },
    { category: 'Water filters', units: 1, cost_cents: 700, floor_cents: 1100, sold_units: 0, sell_through: 0 },
    { category: 'Other', units: 3, cost_cents: 300, floor_cents: 400, sold_units: 1, sell_through: 25 },
  ]);
  assert.deepEqual(rows.map((r) => r.category), ['Kitchen', 'Other']);
  const other = rows[1];
  assert.equal(other.units, 5);
  assert.equal(other.cost_cents, 1500);
  assert.equal(other.floor_cents, 2400);
  assert.equal(other.sold_units, 1);
});
