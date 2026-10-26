import { test } from 'node:test';
import assert from 'node:assert/strict';
import { depopProfit, dollarsText, payoutDefault } from './depopMath.ts';

test('payout pre-fills as sale price minus the Depop fee', () => {
  assert.equal(payoutDefault(2500, 250), 2250);
  assert.equal(payoutDefault(2500, null), null);
  assert.equal(payoutDefault(null, 250), null);
  assert.equal(payoutDefault(100, 500), 0);
});

test('profit is payout minus cost, and waits for a cost', () => {
  assert.equal(depopProfit(2250, 900), 1350);
  assert.equal(depopProfit(2250, 0), 2250);
  assert.equal(depopProfit(2250, null), null);
});

test('money input text', () => {
  assert.equal(dollarsText(2499), '24.99');
  assert.equal(dollarsText(5), '0.05');
});
