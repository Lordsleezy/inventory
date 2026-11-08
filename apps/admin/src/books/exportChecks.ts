import type { BooksWorkbook } from './types';

export type ExportTieIssue = { check: string; message: string };

export function verifyExportTies(wb: BooksWorkbook): ExportTieIssue[] {
  const issues: ExportTieIssue[] = [];
  const money = (cents: number) => cents / 100;
  const sales = wb.sales.rows;
  const sumRev = sales.reduce((n, r) => n + r.price_cents + r.buyer_shipping_cents, 0);
  const sumCost = sales.reduce((n, r) => n + (r.cost_cents ?? 0), 0);
  const sumProfit = sales.reduce((n, r) => n + (r.profit_cents ?? 0), 0);
  const sumComm = sales.reduce((n, r) => n + (r.commission_cents ?? 0), 0);
  const t = wb.sales.totals;

  if (Math.abs(sumRev - t.revenue) > 1) {
    issues.push({ check: 'sales_revenue', message: `Sales revenue: rows $${money(sumRev).toFixed(2)} vs summary $${money(t.revenue).toFixed(2)}` });
  }
  if (Math.abs(sumCost - t.cost) > 1) {
    issues.push({ check: 'sales_cogs', message: `COGS: rows $${money(sumCost).toFixed(2)} vs summary $${money(t.cost).toFixed(2)}` });
  }
  if (Math.abs(sumProfit - t.profit) > 1) {
    issues.push({ check: 'sales_profit', message: `Profit: rows $${money(sumProfit).toFixed(2)} vs summary $${money(t.profit).toFixed(2)}` });
  }
  if (Math.abs(sumComm - t.commission) > 1) {
    issues.push({ check: 'sales_commission', message: `Commission: rows $${money(sumComm).toFixed(2)} vs summary $${money(t.commission).toFixed(2)}` });
  }

  const expRows = wb.expenses.exportRows.filter((r) => r.amount_cents > 0);
  const expSum = expRows.reduce((n, r) => n + r.amount_cents, 0);
  if (Math.abs(expSum - wb.expenses.total_cents) > 1) {
    issues.push({ check: 'expenses_total', message: `Expenses: rows $${money(expSum).toFixed(2)} vs total $${money(wb.expenses.total_cents).toFixed(2)}` });
  }

  const bankSum = wb.payouts.stores.reduce((n, s) => n + s.paid_to_bank_cents, 0);
  if (Math.abs(bankSum - wb.payouts.bankPaidTotal_cents) > 1) {
    issues.push({ check: 'bank_payouts', message: `Paid to bank: lines $${money(bankSum).toFixed(2)} vs total $${money(wb.payouts.bankPaidTotal_cents).toFixed(2)}` });
  }

  const ownerCalc = t.profit - t.commission - t.otherExpenses;
  if (Math.abs(ownerCalc - wb.payouts.owner.ownerKeeps) > 1) {
    issues.push({
      check: 'owner_keeps',
      message: `Owner keeps: profit − commission − other = $${money(ownerCalc).toFixed(2)} vs $${money(wb.payouts.owner.ownerKeeps).toFixed(2)}`,
    });
  }

  const inv = wb.inventory;
  const flow = inv.start_unit_count + inv.received_units + (inv.return_to_stock_units ?? 0)
    - inv.sold_units - inv.giveaway_units - inv.replacement_units - inv.defective_units;
  if (Math.abs(flow - inv.end_unit_count) > 0) {
    issues.push({
      check: 'inventory_flow',
      message: `Inventory: start ${inv.start_unit_count} + in ${inv.received_units} − out ≈ ${flow}, end ${inv.end_unit_count}`,
    });
  }

  if (wb.proof && Math.abs(wb.proof.profit - t.profit) > 1) {
    issues.push({ check: 'hub_profit', message: `Books hub profit $${money(wb.proof.profit).toFixed(2)} vs export $${money(t.profit).toFixed(2)}` });
  }

  return issues;
}
