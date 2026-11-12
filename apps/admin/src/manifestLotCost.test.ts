import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCentsAsDollars, manifestUnitCostCents, parseLotCostCents } from './manifestLotCost.ts';

test('parseLotCostCents accepts dollars and rejects junk', () => {
  assert.equal(parseLotCostCents('100'), 10000);
  assert.equal(parseLotCostCents('12.50'), 1250);
  assert.equal(parseLotCostCents('$8.00'), 800);
  assert.equal(parseLotCostCents('0'), 0);
  assert.equal(parseLotCostCents(''), null);
  assert.equal(parseLotCostCents('12.505'), null);
  assert.equal(parseLotCostCents('-3'), null);
  assert.equal(parseLotCostCents('abc'), null);
});

test('manifestUnitCostCents divides the lot by item count', () => {
  assert.equal(manifestUnitCostCents(10000, 100), 100);
  assert.equal(manifestUnitCostCents(1000, 3), 333);
  assert.equal(manifestUnitCostCents(0, 50), 0);
  assert.equal(manifestUnitCostCents(500, 0), null);
  assert.equal(manifestUnitCostCents(-1, 10), null);
});

test('formatCentsAsDollars is fixed to two places', () => {
  assert.equal(formatCentsAsDollars(1250), '12.50');
  assert.equal(formatCentsAsDollars(100), '1.00');
});
