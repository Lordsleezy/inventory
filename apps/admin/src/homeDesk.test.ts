import test from 'node:test';
import assert from 'node:assert/strict';
import { viewerIsJacob } from './books/personMerge.ts';
import { formatPayoutDue } from './homePayoutDue.ts';

const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n / 100);

test('the payout box is for Jacob only', () => {
  assert.equal(viewerIsJacob('Jacob', 'jacob.store@employees.floor.local'), true);
  assert.equal(viewerIsJacob('', 'jacob.store@employees.floor.local'), true);
  assert.equal(viewerIsJacob('Paul', 'pgg124@gmail.com'), false);
  assert.equal(viewerIsJacob('Steve', 'steve@openboxindustries.com'), false);
});

test('Jacob payout box shows a real minus when the balance is negative', () => {
  assert.equal(formatPayoutDue(1250, money), '$12.50');
  assert.equal(formatPayoutDue(-1250, money), '-$12.50');
  assert.equal(formatPayoutDue(0, money), '$0.00');
});
