import test from 'node:test';
import assert from 'node:assert/strict';
import { liveListedChannels, notListedLines } from './books/sheetChannels.ts';

test('Mercari is left out of listed-by-channel', () => {
  const rows = liveListedChannels([
    { channel: 'ebay', units: 10 },
    { channel: 'mercari', units: 41 },
    { channel: 'depop', units: 4 },
  ]);
  assert.deepEqual(rows.map((r) => r.channel), ['ebay', 'depop']);
});

test('not listed is one total plus defective', () => {
  const lines = notListedLines(
    [{ units: 131, cost_cents: 47700 }, { units: 20, cost_cents: 375000 }],
    { units: 12, cost_cents: 9000 },
  );
  assert.equal(lines.units, 151);
  assert.equal(lines.cost_cents, 422700);
  assert.equal(lines.defective_units, 12);
  assert.equal(lines.defective_cost_cents, 9000);
});
