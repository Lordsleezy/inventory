import test from 'node:test';
import assert from 'node:assert/strict';
import { archivePlan, zipStore } from './books/booksArchivePure.ts';
import type { Period } from './books/types.ts';

test('download all puts each month before the quarter it belongs to', () => {
  const periods = [
    { period_type: 'month', period_start: '2026-11-01', period_end: '2026-11-30' },
    { period_type: 'month', period_start: '2026-09-01', period_end: '2026-09-30' },
    { period_type: 'month', period_start: '2026-10-01', period_end: '2026-10-31' },
  ] as Period[];
  const plan = archivePlan(periods);
  assert.deepEqual(plan.map((item) => item.title), ['September 2026', 'Q3 2026', 'October 2026', 'November 2026', 'Q4 2026']);
  const q3 = plan.find((item) => item.title === 'Q3 2026');
  assert.equal(q3?.start, '2026-07-01');
  assert.equal(q3?.end, '2026-09-30');
  assert.deepEqual(q3?.months.map((month) => month.period_start), ['2026-09-01']);
  assert.equal(plan.find((item) => item.title === 'Q4 2026')?.end, '2026-12-31');
});

test('the archive zip stores each file unchanged', () => {
  const pdf = new Uint8Array([1, 2, 3, 4]);
  const zipped = zipStore([
    { name: 'September-2026.pdf', bytes: pdf },
    { name: 'Books-all-periods.xlsx', bytes: new TextEncoder().encode('sheet') },
  ]);
  assert.equal(zipped[0], 0x50);
  assert.equal(zipped[1], 0x4b);
  const names = new TextDecoder().decode(zipped);
  assert.match(names, /September-2026\.pdf/);
  assert.match(names, /Books-all-periods\.xlsx/);
  const at = zipped.indexOf(1);
  assert.deepEqual([...zipped.slice(at, at + 4)], [1, 2, 3, 4]);
});
