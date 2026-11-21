import test from 'node:test';
import assert from 'node:assert/strict';
import { profitStatement, returnSheetRows } from './books/profitSheet.ts';
import type { BooksWorkbook, SalesLine } from './books/types.ts';

function sale(partial: Partial<SalesLine>): SalesLine {
  return {
    sale_id: '1', date: '2026-11-01', sku: '12153', title: 'Tool set', channel: 'eBay',
    order_no: '123', qty: 1, price_cents: 0, tax_cents: 0, marketplace_fees_cents: 0,
    card_fees_cents: 0, buyer_shipping_cents: 0, label_cost_cents: 0, cost_cents: 0,
    profit_cents: 0, commission_cents: 0, profit_notes: '', ...partial,
  };
}

function workbook(sales: SalesLine[], returns: Record<string, unknown>[], extra: Partial<BooksWorkbook> = {}): BooksWorkbook {
  const profit = sales.reduce((sum, row) => sum + (row.profit_cents ?? 0), 0);
  return {
    sales: {
      rows: sales,
      channelTotals: [],
      totals: { commission: extra.sales?.totals?.commission ?? 0, profit } as BooksWorkbook['sales']['totals'],
    },
    inventory: { returns, ...(extra.inventory || {}) } as unknown as BooksWorkbook['inventory'],
    expenses: extra.expenses,
    payouts: extra.payouts,
  } as unknown as BooksWorkbook;
}

test('profit is sales after tax is shown, and shipping, fees, refunds, and cost come out', () => {
  const pricedProfit = 10000 + 500 - 400 - 1200 - 300 - 2000;
  const lines = profitStatement(workbook([
    sale({
      price_cents: 10000, tax_cents: 800, buyer_shipping_cents: 500, label_cost_cents: 400,
      marketplace_fees_cents: 1200, card_fees_cents: 300, cost_cents: 2000, profit_cents: pricedProfit,
    }),
    sale({ sale_id: '2', sku: '12140', price_cents: 1500, cost_cents: null, marketplace_fees_cents: 100, profit_cents: null }),
  ], [
    { sku: '12100', order_id: '999', channel: 'ebay', status: 'closed', refund_cents: 3000, label_cents: 700, date: '2026-11-04' },
    { sku: '12101', order_id: '998', channel: 'ebay', status: 'requested', refund_cents: 1500, label_cents: 0, date: '2026-11-05' },
  ]));
  const byLabel = new Map(lines.map((line) => [line.label, line]));
  assert.equal(byLabel.get('Gross merchandise sales')?.cents, 10000 + 1500 + 3000);
  assert.equal(byLabel.get('Completed refunds')?.cents, 3000);
  assert.equal(byLabel.get('Net merchandise sales')?.cents, 10000 + 1500);
  assert.equal(byLabel.get('Sales tax collected')?.cents, 800);
  assert.equal(byLabel.get('Sales tax collected')?.role, 'info');
  assert.equal(byLabel.get('Customer-paid shipping')?.cents, 500);
  assert.equal(byLabel.get('Outbound shipping')?.cents, 400);
  assert.equal(byLabel.get('Marketplace fees')?.cents, 1300);
  assert.equal(byLabel.get('Card fees')?.cents, 300);
  assert.equal(byLabel.get('Open returns')?.cents, 1500);
  assert.equal(byLabel.get('Open returns')?.role, 'info');
  assert.equal(byLabel.get('Cost of goods sold')?.cents, 2000);
  assert.equal(byLabel.get('Sales left out, cost missing')?.cents, 1500 - 100);
  const commission = Math.round(pricedProfit * 30 / 100);
  assert.equal(byLabel.get('Sales contribution')?.cents, pricedProfit);
  assert.equal(byLabel.get('Return shipping'), undefined);
  assert.equal(byLabel.get('Commissions')?.cents, commission);
  assert.equal(byLabel.get('Owner profit')?.cents, pricedProfit - commission);
  assert.equal(byLabel.get('Owner profit')?.role, 'profit');
  assert.equal(byLabel.get('Total expenses')?.cents, 700);
  assert.equal(byLabel.get('Net after expenses')?.cents, pricedProfit - commission - 700);
  assert.ok((byLabel.get('Owner profit')?.cents || 0) > commission);

  const listed = returnSheetRows([
    { sku: '12153', order_id: '240352', channel: 'ebay', status: 'refunded_no_return', refund_cents: 2000, date: '2026-11-12', buyer_keeps_item: true },
    { sku: '12140', order_id: '55', channel: 'ebay', status: 'requested', refund_cents: 800, date: '2026-11-13' },
  ]);
  assert.equal(listed[0].channel, 'eBay');
  assert.equal(listed[0].status, 'Refunded, buyer kept it');
  assert.equal(listed[0].what, 'Buyer kept it');
  assert.equal(listed[0].countsInProfit, true);
  assert.equal(listed[0].inProfit, 'Yes');
  assert.equal(listed[1].countsInProfit, false);
  assert.equal(listed[1].inProfit, 'Not yet');
});

test('in-store card fees stay out, and expenses, commissions, and giveaways come out of profit', () => {
  const lines = profitStatement(workbook(
    [sale({ channel: 'In-store', price_cents: 2000, card_fees_cents: 60, cost_cents: 500, profit_cents: 1500 })],
    [],
    {
      expenses: { otherExpenses_cents: 250, total_cents: 400 } as unknown as BooksWorkbook['expenses'],
      sales: { totals: { commission: 300 } } as unknown as BooksWorkbook['sales'],
      inventory: { giveaways: [{ cost_cents: 125 }] } as unknown as BooksWorkbook['inventory'],
      payouts: { owner: { ownerKeeps: 1500 - 300 - 250 } } as unknown as BooksWorkbook['payouts'],
    },
  ));
  const byLabel = new Map(lines.map((line) => [line.label, line]));
  assert.equal(byLabel.get('Card fees')?.cents, 0);
  assert.equal(byLabel.get('Card fees the customer paid')?.cents, 60);
  assert.equal(byLabel.get('Card fees the customer paid')?.role, 'info');
  assert.equal(byLabel.get('Sales contribution')?.cents, 1500);
  assert.equal(byLabel.get('Commissions')?.cents, 450);
  assert.equal(byLabel.get('Owner profit')?.cents, 1050);
  assert.equal(byLabel.get('Total expenses')?.cents, 250 + 125);
  assert.equal(byLabel.get('Net after expenses')?.cents, 1050 - 375);
  assert.match(byLabel.get('Owner profit')?.note || '', /70%/);
});
