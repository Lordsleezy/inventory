import test from 'node:test';
import assert from 'node:assert/strict';
import { filingBounds, periodLabel, resolveCdtfaDollars } from './books/cdtfaResolve.ts';

const floor = [
  ['1', 1363], ['2', 0], ['3', 1363], ['4', 0], ['5', 0], ['6', 0], ['7', 0], ['8', 0], ['9', 0], ['10', 0],
  ['A11', 0], ['B1', 0], ['B2', 0], ['B3', 0], ['B4', 0], ['B5', 0], ['11', 0], ['12', 1363],
  ['13', 82], ['14', 3], ['15', 14], ['16', 0], ['17', 99], ['18', 0], ['19', 99],
  ['20a', 0], ['20b', 0], ['20c', 0], ['20d', 0], ['20e', 0], ['21', 99], ['22', 0], ['23', 99], ['24', 0], ['25', 0], ['26', 99],
].map(([id, dollars]) => ({ id: String(id), dollars: Number(dollars) }));

test('editing line 11 rebuilds taxable sales and the tax lines', () => {
  const rows = resolveCdtfaDollars(floor, { '11': 100 }, 99);
  const at = (id: string) => rows.find((row) => row.id === id)!;
  assert.equal(at('11').dollars, 100);
  assert.equal(at('11').edited, true);
  assert.equal(at('12').dollars, 1263);
  assert.equal(at('13').dollars, Math.round(1263 * 0.06));
  assert.equal(at('26').dollars, at('23').dollars);
  assert.equal(at('1').dollars, 1363);
  assert.equal(at('18').dollars, 0);
});

test('a late filing date adds a 10 percent penalty and leaves interest out of the total', () => {
  const rows = resolveCdtfaDollars(floor, {}, 0, true);
  const at = (id: string) => rows.find((row) => row.id === id)!;
  assert.equal(at('23').dollars, 99);
  assert.equal(at('24').dollars, 10);
  assert.equal(at('24').edited, false);
  assert.equal(at('25').dollars, 0);
  assert.equal(at('26').dollars, 109);
});

test('an on-time filing date does not add a penalty', () => {
  const rows = resolveCdtfaDollars(floor, { '24': 50 }, 0, false);
  const at = (id: string) => rows.find((row) => row.id === id)!;
  assert.equal(at('24').dollars, 0);
  assert.equal(at('26').dollars, 99);
});

test('Q3 2026 is the quarter that contains September', () => {
  assert.deepEqual(filingBounds('2026-09-01', 'quarterly'), { start: '2026-07-01', end: '2026-09-30' });
  assert.equal(periodLabel('2026-07-01', '2026-09-30', 'quarterly', '2026-10-31'), 'Q3 2026 · Jul–Sep · due Oct 31');
});
