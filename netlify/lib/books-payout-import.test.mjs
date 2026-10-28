import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBooksPayout, saveBooksPayout } from './books-payout-import.mjs';

test('imports only successful eBay payout deposits with the bank reference', () => {
  assert.deepEqual(normalizeBooksPayout('ebay', { payoutId: 'p-1', payoutStatus: 'SUCCEEDED', amount: { value: '123.45' }, payoutDate: '2026-10-28T10:00:00Z', bankReference: 'bank-1' }), {
    platform: 'ebay', external_payout_id: 'p-1', amount_cents: 12345, withdrawn_on: '2026-10-28', bank_reference: 'bank-1', note: 'Imported from eBay Finances API',
  });
  assert.equal(normalizeBooksPayout('ebay', { payoutId: 'p-2', payoutStatus: 'TERMINAL_FAILED', amount: { value: '12.00' }, payoutDate: '2026-10-28' }), null);
});

test('imports only positive completed Square payouts and preserves end-to-end reference', () => {
  assert.deepEqual(normalizeBooksPayout('square', { id: 'sq-1', status: 'PAID', amount_money: { amount: 9812, currency_code: 'USD' }, arrival_date: '2026-10-28', end_to_end_id: 'e2e-1' }), {
    platform: 'square', external_payout_id: 'sq-1', amount_cents: 9812, withdrawn_on: '2026-10-28', bank_reference: 'e2e-1', note: 'Imported from Square API',
  });
  assert.equal(normalizeBooksPayout('square', { id: 'sq-2', status: 'FAILED', amount_money: { amount: 1000 }, arrival_date: '2026-10-28' }), null);
  assert.equal(normalizeBooksPayout('square', { id: 'sq-3', status: 'PAID', amount_money: { amount: -100 }, arrival_date: '2026-10-28' }), null);
});

test('TikTok PAID USD settlement is imported by payment id and non-USD is skipped', () => {
  const row = normalizeBooksPayout('tiktok', { id: 'pay-1', status: 'PAID', amount: { value: '21.42', currency: 'USD' }, paid_time: 1793145600 });
  assert.equal(row.platform, 'tiktok');
  assert.equal(row.external_payout_id, 'pay-1');
  assert.equal(row.amount_cents, 2142);
  assert.equal(row.bank_reference, null);
  assert.equal(normalizeBooksPayout('tiktok', { id: 'pay-2', status: 'PAID', amount: { value: '20', currency: 'GBP' }, paid_time: 1793145600 }), null);
  assert.equal(normalizeBooksPayout('tiktok', { id: 'pay-3', status: 'PROCESSING', amount: { value: '20', currency: 'USD' }, paid_time: 1793145600 }), null);
});

function booksDb(locked) {
  const writes = [];
  const sb = { from(table) {
    if (table === 'books_periods') {
      const query = { select() { return this; }, eq() { return this; }, lte() { return this; }, gte() { return this; }, async maybeSingle() { return { data: locked ? { id: 'locked' } : null, error: null }; } };
      return query;
    }
    return { async upsert(row, options) { writes.push({ row, options }); return { error: null }; } };
  } };
  return { sb, writes };
}

test('a payout in a locked month is skipped without changing the closed ledger', async () => {
  const { sb, writes } = booksDb(true);
  const result = await saveBooksPayout(sb, 'store-1', normalizeBooksPayout('square', { id: 'sq-1', status: 'PAID', amount_money: { amount: 900 }, arrival_date: '2026-10-28' }));
  assert.equal(result.reason, 'books_period_locked');
  assert.equal(writes.length, 0);
});

test('payout imports use the external payout identity for idempotency', async () => {
  const { sb, writes } = booksDb(false);
  await saveBooksPayout(sb, 'store-1', normalizeBooksPayout('ebay', { payoutId: 'eb-1', payoutStatus: 'SUCCEEDED', amount: { value: '9.00' }, payoutDate: '2026-10-28' }));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.onConflict, 'store_id,platform,external_payout_id');
  assert.equal(writes[0].row.external_payout_id, 'eb-1');
});
