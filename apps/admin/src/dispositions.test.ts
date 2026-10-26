import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costLabel, parseDollars, replacementAddback, replacementLine, replacementsBySale, showDispositionButtons, type Disposition } from './dispositions.ts';

const money = (n: number) => `$${(n / 100).toFixed(2)}`;
const base: Disposition = {
  id: 'a', kind: 'replacement', sku: '12345', item: 'Thing', cost_cents: 1500, extra_cost_cents: 500, cost_missing: false,
  original_sale_id: 7, original_sku: '11111', original_receipt_no: 'R-1', original_channel: 'ebay', original_sold_at: null,
  bad_unit_status: 'pending', bad_unit_sku: null, given_to: null, note: null, expense_id: null,
  recorded_by_name: 'Paul', created_at: '2026-10-25T10:00:00Z', undone_at: null, undone_by_name: null,
};

test('buttons are admin-only and only on in-stock units', () => {
  assert.equal(showDispositionButtons({ isAdmin: true, inStock: true }), true);
  assert.equal(showDispositionButtons({ isAdmin: false, inStock: true }), false, 'clerk / local account');
  assert.equal(showDispositionButtons({ isAdmin: true, associateBrowseOnly: true, inStock: true }), false, 'associate browse view');
  assert.equal(showDispositionButtons({ isAdmin: true, inStock: false }), false);
});

test('dollar entry', () => {
  assert.equal(parseDollars(''), 0);
  assert.equal(parseDollars('12.5'), 1250);
  assert.equal(parseDollars('$4.99'), 499);
  assert.equal(parseDollars('abc'), null);
  assert.equal(parseDollars('-1'), null);
});

test('a missing cost is never guessed', () => {
  assert.equal(costLabel({ cost_cents: null, extra_cost_cents: 0, cost_missing: true }, money), 'cost missing');
  assert.equal(costLabel(base, money), '$20.00 ($15.00 + $5.00 extra)');
  assert.equal(replacementLine({ ...base, cost_cents: null, cost_missing: true }, money, () => 'Oct 25'), 'Replacement sent: SKU 12345, cost missing, Oct 25');
  assert.equal(replacementLine(base, money, () => 'Oct 25'), 'Replacement sent: SKU 12345, cost $20.00, Oct 25');
});

test('only active replacements annotate the original sale', () => {
  const map = replacementsBySale([base, { ...base, id: 'b', undone_at: '2026-10-26T00:00:00Z' }, { ...base, id: 'c', kind: 'giveaway', original_sale_id: null }]);
  assert.equal(map.get(7)?.length, 1);
  assert.equal(map.size, 1);
});

test('payout adjustment add-back nets a replacement line to zero in both directions', () => {
  assert.equal(replacementAddback({ amount_cents: -200, replacement_id: 'x' }), 200);
  assert.equal(replacementAddback({ amount_cents: 200, replacement_id: 'x' }), -200);
  assert.equal(replacementAddback({ amount_cents: -200, replacement_id: null }), 0, 'return adjustments keep their own add-back rule');
});

test('fee-rule adjustments are paired with an add-back so the balance only moves once', () => {
  assert.equal(replacementAddback({ amount_cents: 700, fee_rule_change: true }), -700);
  assert.equal(replacementAddback({ amount_cents: -700, fee_rule_change: true }), 700);
  assert.equal(replacementAddback({ amount_cents: -700, fee_rule_change: false }), 0);
});
