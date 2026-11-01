import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquisitionCostCents,
  compareMissingCost,
  includeMissingCostUnit,
  inventoryChipLabels,
  mergeMissingCost,
  missingCostSubmitError,
  takeMissingCostPage,
} from './missingCost.ts';

test('acquisition cost uses the item editor dollar rules', () => {
  assert.equal(acquisitionCostCents(''), null);
  assert.equal(acquisitionCostCents('   '), null);
  assert.equal(acquisitionCostCents('9'), 900);
  assert.equal(acquisitionCostCents('9.1'), 910);
  assert.equal(acquisitionCostCents('12.50'), 1250);
  assert.equal(acquisitionCostCents('$1,234.50'), 123450);
  assert.equal(acquisitionCostCents('0'), 0);
  assert.equal(acquisitionCostCents('0.00'), 0);
  assert.equal(acquisitionCostCents('abc'), undefined);
  assert.equal(acquisitionCostCents('12.999'), undefined);
  assert.equal(acquisitionCostCents('-1'), undefined);
});

test('submitting a blank or non-numeric cost explains why it was not saved', () => {
  assert.equal(missingCostSubmitError(''), 'Enter a cost before submitting.');
  assert.equal(missingCostSubmitError('  '), 'Enter a cost before submitting.');
  assert.match(missingCostSubmitError('nope') || '', /number/);
  assert.match(missingCostSubmitError('12.999') || '', /number/);
  assert.equal(missingCostSubmitError('0'), null);
  assert.equal(missingCostSubmitError('4.25'), null);
});

test('missing cost is in-stock and sold units the inventory list already shows', () => {
  assert.equal(includeMissingCostUnit({ state: 'sold', acquisition_cost_cents: null, defective: true }), true);
  assert.equal(includeMissingCostUnit({ state: 'sold', acquisition_cost_cents: null, not_for_sale: true }), true);
  assert.equal(includeMissingCostUnit({ state: 'available', acquisition_cost_cents: null }), true);
  assert.equal(includeMissingCostUnit({ state: 'reserved', acquisition_cost_cents: null }), true);
  assert.equal(includeMissingCostUnit({ state: 'repair', acquisition_cost_cents: null }), true);
  assert.equal(includeMissingCostUnit({ state: 'available', acquisition_cost_cents: null, defective: false, not_for_sale: false }), true);
  assert.equal(includeMissingCostUnit({ state: 'available', acquisition_cost_cents: null, defective: true }), false);
  assert.equal(includeMissingCostUnit({ state: 'available', acquisition_cost_cents: null, not_for_sale: true }), false);
  assert.equal(includeMissingCostUnit({ state: 'available', acquisition_cost_cents: 500 }), false);
  assert.equal(includeMissingCostUnit({ state: 'sold', acquisition_cost_cents: 0 }), false);
});

test('sold units missing cost sort ahead of in-stock, recently sold then SKU', () => {
  const rows = [
    { sku: '10', state: 'available', sold_at: null },
    { sku: '30', state: 'sold', sold_at: '2026-01-01T00:00:00Z' },
    { sku: '20', state: 'sold', sold_at: '2026-06-01T00:00:00Z' },
    { sku: '40', state: 'available', sold_at: null },
  ].sort(compareMissingCost);
  assert.deepEqual(rows.map(row => row.sku), ['20', '30', '40', '10']);
});

test('a costed representative ends the page but a member with no cost is kept', () => {
  const page = takeMissingCostPage([
    { sku: '5', state: 'available', acquisition_cost_cents: null },
    {
      sku: '9', state: 'available', acquisition_cost_cents: 100,
      group_members: [
        { sku: '9', state: 'available', acquisition_cost_cents: 100 },
        { sku: '8', state: 'available', acquisition_cost_cents: null },
        { sku: '7', state: 'available', acquisition_cost_cents: null, defective: true },
      ],
    },
  ]);
  assert.equal(page.done, true);
  assert.deepEqual(page.units.map(unit => unit.sku), ['5', '8']);
});

test('merged in-stock and sold rows stay unique and sold-first', () => {
  const merged = mergeMissingCost([
    [{ sku: '3', state: 'available', acquisition_cost_cents: null }],
    [{ sku: '3', state: 'available', acquisition_cost_cents: null }, { sku: '9', state: 'sold', sold_at: '2026-02-01', acquisition_cost_cents: null }],
  ]);
  assert.deepEqual(merged.map(unit => unit.sku), ['9', '3']);
});

test('Missing cost is the last phone chip and can show a count', () => {
  const hidden = inventoryChipLabels({ noLocation: 810, missingCost: null, showMissingCost: false });
  assert.deepEqual(hidden.map(([, label]) => label), ['In stock', 'Sold', 'Needs check', 'No location 810']);
  const shown = inventoryChipLabels({ noLocation: 810, missingCost: 42, showMissingCost: true });
  assert.equal(shown.at(-1)?.[0], 'missing_cost');
  assert.equal(shown.at(-1)?.[1], 'Missing cost 42');
});
