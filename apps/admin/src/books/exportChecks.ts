import type { BooksWorkbook } from './types';

export type ExportTieIssue = { check: string; message: string };

const MIN_CENTS = 1; // $0.01

function dollars(cents: number) {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function off(left: number, right: number, leftName: string, rightName: string, what: string) {
  const gap = Math.abs(left - right);
  return `${what}: ${leftName} add up to ${dollars(left)} but ${rightName} says ${dollars(right)} (${dollars(gap)} off)`;
}

export function verifyExportTies(wb: BooksWorkbook): ExportTieIssue[] {
  const issues: ExportTieIssue[] = [];
  const sales = wb.sales.rows;
  const sumRev = sales.reduce((n, r) => n + r.price_cents + r.buyer_shipping_cents, 0);
  const sumCost = sales.reduce((n, r) => n + (r.cost_cents ?? 0), 0);
  const sumProfit = sales.reduce((n, r) => n + (r.profit_cents ?? 0), 0);
  const sumComm = sales.reduce((n, r) => n + (r.commission_cents ?? 0), 0);
  const t = wb.sales.totals;

  if (Math.abs(sumRev - t.revenue) >= MIN_CENTS) {
    issues.push({ check: 'sales_revenue', message: off(sumRev, t.revenue, 'sale rows', 'the summary', 'Sales') });
  }
  if (Math.abs(sumCost - t.cost) >= MIN_CENTS) {
    issues.push({ check: 'sales_cogs', message: off(sumCost, t.cost, 'sale rows', 'the summary', 'Cost of goods') });
  }
  if (Math.abs(sumProfit - t.profit) >= MIN_CENTS) {
    issues.push({ check: 'sales_profit', message: off(sumProfit, t.profit, 'sale rows', 'the summary', 'Profit') });
  }
  if (Math.abs(sumComm - t.commission) >= MIN_CENTS) {
    issues.push({ check: 'sales_commission', message: off(sumComm, t.commission, 'sale rows', 'the summary', 'Commissions') });
  }

  const expRows = wb.expenses.exportRows.filter((r) => r.amount_cents > 0);
  const expSum = expRows.reduce((n, r) => n + r.amount_cents, 0);
  if (Math.abs(expSum - wb.expenses.total_cents) >= MIN_CENTS) {
    issues.push({ check: 'expenses_total', message: off(expSum, wb.expenses.total_cents, 'expense rows', 'the total', 'Expenses') });
  }

  const bankSum = wb.payouts.stores.reduce((n, s) => n + s.paid_to_bank_cents, 0);
  if (Math.abs(bankSum - wb.payouts.bankPaidTotal_cents) >= MIN_CENTS) {
    issues.push({ check: 'bank_payouts', message: off(bankSum, wb.payouts.bankPaidTotal_cents, 'payout lines', 'the total', 'Paid to the bank') });
  }

  const ownerCalc = t.profit - t.commission - t.otherExpenses;
  if (Math.abs(ownerCalc - wb.payouts.owner.ownerKeeps) >= MIN_CENTS) {
    issues.push({
      check: 'owner_keeps',
      message: `Owner keeps: profit minus commissions minus other expenses is ${dollars(ownerCalc)}, but the summary says ${dollars(wb.payouts.owner.ownerKeeps)} (${dollars(Math.abs(ownerCalc - wb.payouts.owner.ownerKeeps))} off)`,
    });
  }

  const inv = wb.inventory;
  const flow = inv.start_unit_count + inv.received_units + (inv.return_to_stock_units ?? 0)
    - inv.sold_units - inv.giveaway_units - inv.replacement_units - inv.defective_units;
  if (Math.abs(flow - inv.end_unit_count) >= 1) {
    issues.push({
      check: 'inventory_flow',
      message: `Inventory count doesn't tie: starting stock plus units in, minus units out, comes to ${flow}, but the ending count is ${inv.end_unit_count}`,
    });
  }

  if (wb.proof && Math.abs(wb.proof.profit - t.profit) >= MIN_CENTS) {
    issues.push({ check: 'hub_profit', message: `Profit: the summary says ${dollars(wb.proof.profit)} but the export total says ${dollars(t.profit)} (${dollars(Math.abs(wb.proof.profit - t.profit))} off)` });
  }

  return issues;
}
