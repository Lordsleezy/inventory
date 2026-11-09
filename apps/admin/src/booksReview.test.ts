import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveCostCents } from './books/costTruth.ts';
import { verifyBooksIntegrity } from './books/booksProof.ts';
import { verifyExportTies } from './books/exportChecks.ts';
import { listBookIssues, reviewDestination } from './books/booksReview.ts';
import { cdtfaPdfFileName } from './books/cdtfaExport.ts';
import type { BooksWorkbook, Report } from './books/types.ts';

test('a recorded unit cost of zero is a real cost, a blank zero is still missing', () => {
  assert.equal(effectiveCostCents({ qty: 1, unit_cost_cents: 0, cost_cents: 0, cost_source: 'unit' }), 0);
  assert.equal(effectiveCostCents({ qty: 1, unit_cost_cents: 0, cost_cents: null }), null);
  assert.equal(effectiveCostCents({ qty: 1, unit_cost_cents: null, cost_cents: 0 }), null);
});

test('the old payout total is not shown, and a cost gap is plain English', () => {
  const workbook = {
    sales: {
      rows: [{ sale_id: '1', profit_cents: 536116, commission_cents: 0, cost_cents: 207500, price_cents: 0, buyer_shipping_cents: 0 }],
      totals: { revenue: 0, cost: 185700, profit: 480916, commission: 0, otherExpenses: 0, fees: 0, feesAndLabels: 0, labelCostsOnSales: 0, expense: 0, ownerKeeps: 0, shippingSurplus: 0, ledgerProfitGap: 0 },
      channelTotals: [],
    },
    proof: { profit: 480916, ownerBeforeOther: 480916 },
    audit: [],
    payouts: { commissions: [], stores: [], bankPaidTotal_cents: 0, owner: { ownerKeeps: 0 } },
    expenses: { rows: [], exportRows: [], total_cents: 0 },
    inventory: { start_unit_count: 0, end_unit_count: 0, received_units: 0, sold_units: 0, giveaway_units: 0, replacement_units: 0, defective_units: 0, return_to_stock_units: 0 },
  } as unknown as BooksWorkbook;
  const integrity = verifyBooksIntegrity(workbook, { payouts: [{ amount_cents: 176611 }] } as unknown as Report);
  assert.equal(integrity.issues.some((issue) => /legacy|not used/i.test(issue.message)), false);
  const ties = verifyExportTies(workbook);
  assert.equal(ties.find((issue) => issue.check === 'sales_cogs')?.message, 'Cost of goods: sale rows add up to $2,075.00 but the summary says $1,857.00 ($218.00 off)');
  assert.match(ties.find((issue) => issue.check === 'sales_profit')?.message || '', /Profit: sale rows add up to \$5,361\.16 but the summary says \$4,809\.16/);
});

test('every books issue opens the screen that fixes it', () => {
  assert.equal(reviewDestination('unmatched_label').sheet, 'expenses');
  assert.match(reviewDestination('unmatched_label').action, /Match/);
  assert.equal(reviewDestination('sales_cogs').sheet, 'sales');
  assert.equal(reviewDestination('sales_profit').sheet, 'sales');
  assert.equal(reviewDestination('owner').sheet, 'sales');
  assert.equal(reviewDestination('in_store_fee').sheet, 'sales');
  assert.equal(reviewDestination('commission').sheet, 'payouts');
  assert.equal(reviewDestination('sales_commission').sheet, 'payouts');
  assert.equal(reviewDestination('owed_paul').sheet, 'payouts');
  assert.equal(reviewDestination('owed_jacob').sheet, 'payouts');
  assert.equal(reviewDestination('bank_payouts').sheet, 'payouts');
  assert.equal(reviewDestination('owner_keeps').sheet, 'payouts');
  assert.equal(reviewDestination('expenses_total').sheet, 'expenses');
  assert.equal(reviewDestination('inventory_flow').sheet, 'inventory');
  const issues = listBookIssues({
    integrity: { ok: true, commissionGap_cents: 0, ownerGap_cents: 0, owedPaulGap_cents: null, owedJacobGap_cents: null, issues: [] },
    exportTieIssues: [],
    sales: { rows: [], channelTotals: [], totals: { revenue: 0, cost: 0, profit: 0, commission: 0, otherExpenses: 0, fees: 0, feesAndLabels: 0, labelCostsOnSales: 0, expense: 0, ownerKeeps: 0, shippingSurplus: 0, ledgerProfitGap: 0 } },
  } as unknown as BooksWorkbook);
  assert.equal(issues.length, 0);
});

test('excel zip names the official tax form for the same period', () => {
  assert.equal(cdtfaPdfFileName('2026-11-01', '2026-11-30'), 'CDTFA-401-A-2026-11.pdf');
  assert.equal(cdtfaPdfFileName('2026-10-01', '2026-12-31'), 'CDTFA-401-A-2026-Q4.pdf');
});
