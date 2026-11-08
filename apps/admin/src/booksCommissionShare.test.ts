import test from 'node:test';
import assert from 'node:assert/strict';
import { shareTicketCents } from './books/commissionShare.ts';

test('a two-line ticket commission is split and still adds up', () => {
  const first = shareTicketCents(11400, [0.5, 0.5], 0);
  const second = shareTicketCents(11400, [0.5, 0.5], 1);
  assert.equal(first + second, 11400);
  assert.ok(first < 11400 && second < 11400);
});
