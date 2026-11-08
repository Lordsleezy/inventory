import test from 'node:test';
import assert from 'node:assert/strict';
import { profitHeadlineGap } from './payouts.ts';

test('all-time profit rows are $79.83 above the headline', () => {
  const gap = profitHeadlineGap({
    gross: 1295822,
    fees: 50455,
    ship: 50468,
    processing: 2852,
    tax: 66012,
    cost: 355650,
    profit: 762402,
  });
  assert.equal(gap, 7983);
});

test('a headline that matches the rows has no gap', () => {
  assert.equal(profitHeadlineGap({
    gross: 1000, fees: 100, ship: 50, processing: 25, tax: 25, cost: 200, profit: 600,
  }), 0);
});
