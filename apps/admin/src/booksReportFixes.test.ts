import test from 'node:test';
import assert from 'node:assert/strict';
import { unpaidCarryCents } from './books/carryExpenses.ts';
import { buildExpenses } from './books/expenseBuild.ts';
import { profitStatement } from './books/profitSheet.ts';
import { applySaleFeeAdjustments } from './books/saleAdjustments.ts';
import type { BooksWorkbook, Report } from './books/types.ts';

test('a promoted listing fee lands on that sale marketplace fee', () => {
  const report = applySaleFeeAdjustments({
    sales: [{ id: '9', order_id: '12-34567-89012', channel_fee_cents: 400, profit_cents: 1000, price_cents: 2000 }],
    fees: [{ id: 'fee-1', type: 'Promoted listings', order_id: '123456789012', amount_cents: 125, account: 'ikonikdeals2026' }],
  } as unknown as Report);
  const sale = report.sales[0];
  assert.equal(sale.channel_fee_cents, 525);
  assert.equal(sale.profit_cents, 875);
  assert.deepEqual(report.books_attributed_fee_ids, ['fee-1']);
  const expenses = buildExpenses(report, new Set(report.books_attributed_fee_ids || []));
  assert.equal(expenses.rows.some((row) => row.kindKey === 'promoted'), false);
  assert.equal(expenses.otherExpenses_cents, 0);
});

test('a promoted fee with no order number is split across eBay sales by price', () => {
  const report = applySaleFeeAdjustments({
    sales: [
      { id: '1', channel: 'ebay', price_cents: 3000, channel_fee_cents: 100, profit_cents: 2000 },
      { id: '2', channel: 'ebay', price_cents: 1000, channel_fee_cents: 40, profit_cents: 800 },
      { id: '3', channel: 'floor', price_cents: 5000, channel_fee_cents: 0, profit_cents: 5000 },
    ],
    fees: [{ id: 'fee-gen', type: 'Promoted Listings - General fee · shop', amount_cents: 80, account: 'shop' }],
  } as unknown as Report);
  assert.equal(report.sales[0].channel_fee_cents, 160);
  assert.equal(report.sales[1].channel_fee_cents, 60);
  assert.equal(report.sales[2].channel_fee_cents, 0);
  assert.equal(Number(report.sales[0].channel_fee_cents) + Number(report.sales[1].channel_fee_cents) - 140, 80);
  const expenses = buildExpenses(report, new Set(report.books_attributed_fee_ids || []));
  assert.equal(expenses.rows.some((row) => row.kindKey === 'promoted'), false);
});

test('a promoted fee tied to an unknown order stays visible', () => {
  const report = applySaleFeeAdjustments({
    sales: [{ id: '9', channel: 'ebay', order_id: '12-34567-89012', price_cents: 2000, channel_fee_cents: 400, profit_cents: 1000 }],
    fees: [{ id: 'fee-2', type: 'Promoted listings', order_id: 'no-such-order', amount_cents: 80, account: 'ikonikdeals2026' }],
  } as unknown as Report);
  assert.equal(report.sales[0].channel_fee_cents, 400);
  const expenses = buildExpenses(report, new Set(report.books_attributed_fee_ids || []));
  const row = expenses.rows.find((item) => item.kindKey === 'promoted');
  assert.equal(row?.amount_cents, 80);
  assert.match(row?.title || '', /not matched to a sale/);
  assert.equal(expenses.otherExpenses_cents, 80);
});

test('a bonus is included in commissions and is not also an operating expense', () => {
  const expenses = buildExpenses({
    expenses: [{ id: 'b1', date: '2026-11-07', category: 'Bonus', description: 'Bonus', amount_cents: 10000, source: 'manual', needs_reimbursement: false }],
    sales: [],
    fees: [],
    labels: [],
    returns: [],
  } as unknown as Report, new Set());
  assert.equal(expenses.bonus_cents, 10000);
  assert.equal(expenses.otherExpenses_cents, 0);
  assert.equal(expenses.exportRows[0].treatment, 'Included in commissions');
  const lines = profitStatement({
    sales: {
      rows: [{
        price_cents: 100000, profit_cents: 100000, cost_cents: 0, marketplace_fees_cents: 0,
        card_fees_cents: 0, buyer_shipping_cents: 0, label_cost_cents: 0, tax_cents: 0, channel: 'eBay',
      }],
      totals: { commission: 30000, profit: 100000 },
    },
    expenses,
    inventory: { returns: [] },
    payouts: { commissions: [{ person: 'Paul', role: 'staff', earned_cents: 30000 }], owner: { ownerKeeps: 60000 } },
  } as unknown as BooksWorkbook);
  const byLabel = new Map(lines.map((line) => [line.label, line]));
  assert.equal(byLabel.get('Commissions')?.cents, 30000);
  assert.equal(byLabel.get('Owner profit')?.cents, 70000);
  assert.equal(byLabel.get('Total expenses')?.cents, 0);
  assert.equal(byLabel.get('Net after expenses')?.cents, 70000);
  assert.match(byLabel.get('Commissions')?.note || '', /Bonus/);
});

test('an unpaid reimbursement from an earlier month stays until a payment covers it', () => {
  const expense = { id: 'old', at: '2026-10-04', amount: 2000, employee_id: 'jacob' };
  const still = unpaidCarryCents([expense], [], '2026-11-01', '2026-11-30');
  assert.equal(still.get('old'), 2000);
  const paidLater = unpaidCarryCents(
    [expense],
    [{ at: '2026-12-02', amount: 2000, employee_id: 'jacob' }],
    '2026-11-01',
    '2026-11-30',
  );
  assert.equal(paidLater.get('old'), 2000);
  const paidThisMonth = unpaidCarryCents(
    [expense],
    [{ at: '2026-11-15', amount: 2000, employee_id: 'jacob' }],
    '2026-11-01',
    '2026-11-30',
  );
  assert.equal(paidThisMonth.has('old'), false);
  const commissionPayment = unpaidCarryCents(
    [expense],
    [{ at: '2026-11-15', amount: 2000, employee_id: 'jacob', note: '[commission]' }],
    '2026-11-01',
    '2026-11-30',
  );
  assert.equal(commissionPayment.get('old'), 2000);
  const partial = unpaidCarryCents(
    [expense],
    [{ at: '2026-11-15', amount: 500, employee_id: 'jacob' }],
    '2026-11-01',
    '2026-11-30',
  );
  assert.equal(partial.get('old'), 1500);
});
