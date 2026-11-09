import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ledgerOwedFromBalances } from './books/booksProof.ts';

test('the Payouts check uses the card balance, not commission alone', () => {
  const rows = [{ user_id: 'paul', balance: 108767, commissionOwed: 0, reimburseOwed: 108767 }];
  const got = ledgerOwedFromBalances(rows, ['paul'], ['jacob']);
  assert.equal(got.paulOwed, 108767);
  assert.equal(got.jacobOwed, 0);
});
