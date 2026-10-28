import test from 'node:test';
import assert from 'node:assert/strict';
import { activeChannelSales } from './channel-sale-history.mjs';

test('eBay Sold excludes other channels, canceled sales, and state-only sold units', () => {
  const rows = [
    { id: 1, channel: 'ebay', voided_at: null },
    { id: 2, channel: 'depop', listed_on: ['ebay'], voided_at: null },
    { id: 3, channel: 'floor', voided_at: null },
    { id: 4, channel: 'website', voided_at: null },
    { id: 5, channel: 'ebay', voided_at: '2026-10-27' },
    { id: 6, state: 'sold', listed_on: ['ebay'] },
  ];
  assert.deepEqual(activeChannelSales(rows, 'ebay').map(r => r.id), [1]);
});
