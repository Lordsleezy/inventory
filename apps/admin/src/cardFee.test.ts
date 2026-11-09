import test from 'node:test';
import assert from 'node:assert/strict';
import { booksCardFeeCents } from './books/cardFee.ts';

test('an in-store sale that charged the card fee on top of the price reports no fee', () => {
  assert.equal(booksCardFeeCents({
    channel: 'floor',
    card_fee_cents: 1070,
    processing_fee_cents: 1213,
  }), 0);
});

test('an in-store card sale with no surcharge still shows the fee the store paid', () => {
  assert.equal(booksCardFeeCents({
    channel: 'floor',
    card_fee_cents: 0,
    processing_fee_cents: 1213,
  }), 1213);
});

test('an online sale keeps its processing fee', () => {
  assert.equal(booksCardFeeCents({
    channel: 'ebay',
    card_fee_cents: 0,
    processing_fee_cents: 400,
  }), 400);
});
