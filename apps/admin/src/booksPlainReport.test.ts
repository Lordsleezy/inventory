import test from 'node:test';
import assert from 'node:assert/strict';
import { pacificDay, pacificInRange } from './books/pacificDay.ts';
import { commissionTie, expenseTie, inventoryFlow, missingCostPicture, moneyReasonLabel, reportTiming } from './books/plainReport.ts';
import { profitStatement } from './books/profitSheet.ts';
import type { BooksWorkbook, Period } from './books/types.ts';

test('a timestamp after midnight UTC is still the previous Pacific day', () => {
  assert.equal(pacificDay('2026-11-21T03:00:00Z'), '2026-11-20');
  assert.equal(pacificDay('2026-11-21T08:00:00Z'), '2026-11-21');
  assert.equal(pacificDay('2026-11-21'), '2026-11-21');
  assert.equal(pacificInRange('2026-11-21T03:00:00Z', '2026-11-01', '2026-11-20'), true);
  assert.equal(pacificInRange('2026-11-21T08:00:00Z', '2026-11-01', '2026-11-20'), false);
});

test('an open month is labeled preliminary and a locked month is final', () => {
  const period = { status: 'draft', period_start: '2026-11-01', period_end: '2026-11-30' } as Period;
  const open = reportTiming(period, new Date('2026-11-21T02:00:00Z'));
  assert.equal(open.status, 'Month to date — preliminary');
  assert.equal(open.preliminary, true);
  const locked = reportTiming({ ...period, status: 'locked' }, new Date('2026-12-05T20:00:00Z'));
  assert.equal(locked.status, 'Final — locked');
  assert.equal(locked.preliminary, false);
});

test('inventory movement, expense split, missing cost, and commission gap stay visible', () => {
  const wb = {
    inventory: {
      start_unit_count: 10, received_units: 4, return_to_stock_units: 1, sold_units: 3,
      giveaway_units: 1, replacement_units: 0, defective_units: 1, end_unit_count: 10,
      giveaways: [{ cost_cents: 3200 }], returns: [],
    },
    expenses: { total_cents: 1000, otherExpenses_cents: 400, reimburse_cents: 150, categoryTotals: [{ category: 'Giveaway', amount_cents: 500 }] },
    sales: { rows: [
      { cost_cents: null },
      { cost_cents: 0 },
      { cost_cents: 200 },
    ], totals: { commission: 131927 } },
    payouts: { commissions: [
      { person: 'Paul', role: 'staff', earned_cents: 95656, paid_cents: 0, owed_all_time_cents: 0 },
      { person: 'Jacob', role: 'staff', earned_cents: 35082, paid_cents: 0, owed_all_time_cents: 0 },
    ] },
    received: [{ cost_cents: null, qty_on_hand: 2 }, { cost_cents: 0, qty_on_hand: 1 }],
  } as unknown as BooksWorkbook;
  const flow = inventoryFlow(wb);
  assert.equal(flow.calculated, 10);
  assert.equal(flow.ties, true);
  const exp = expenseTie(wb);
  assert.equal(exp.already + exp.operating, exp.recorded);
  assert.equal(exp.operating, 400);
  const missing = missingCostPicture(wb);
  assert.equal(missing.unknownSales, 1);
  assert.equal(missing.zeroCostSales, 1);
  assert.equal(missing.receivedMissing, 2);
  const comm = commissionTie(wb);
  assert.equal(comm.named, 95656 + 35082);
  assert.equal(comm.deducted - comm.named, 1189);
  assert.equal(moneyReasonLabel('count_correction'), 'Count correction');
  const lines = profitStatement(wb);
  assert.equal(lines.find((line) => line.label === 'Commissions')?.cents, 95656 + 35082);
  assert.equal(lines.find((line) => line.label === 'Owner profit')?.cents, -(95656 + 35082));
});
