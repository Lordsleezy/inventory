import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commissionStaysInOwed, refundCommissionUndo } from './payouts.ts';

const undo = (cents: number, ticket = 'sale:1') => ({
  amount_cents: cents,
  reason: 'Refund SKU 1 · undoes the commission · 100 cents refunded · return x',
  ticket_key: ticket,
});

test('a full refund leaves the sale commission out of the owed total', () => {
  assert.equal(refundCommissionUndo([undo(-184)], 'sale:1'), -184);
  assert.equal(commissionStaysInOwed(184, -184), false);
});

test('a partial refund keeps the unrefunded commission', () => {
  assert.equal(commissionStaysInOwed(1200, -760), true);
});

test('other adjustments do not undo a sale', () => {
  assert.equal(refundCommissionUndo([{ amount_cents: -500, reason: 'bonus fix', ticket_key: 'sale:1' }], 'sale:1'), 0);
  assert.equal(commissionStaysInOwed(500, 0), true);
});
