import { effectiveCostCents } from './costTruth.ts';
import type { BooksWorkbook, Report, Row, SalesLine } from './types';

export type ReviewSheet = 'sales' | 'expenses' | 'payouts' | 'inventory' | 'received' | 'tax';

export type ReviewLabel = {
  id: string;
  date: string;
  amount_cents: number;
  title: string;
  source: string;
  carrier: string;
  tracking: string;
  orderId: string;
  sku: string;
  suggestedSaleId: string;
};

export type ReviewIssue = {
  id: string;
  kind: string;
  message: string;
  sheet: ReviewSheet;
  action: string;
  sales: SalesLine[];
  label?: ReviewLabel;
};

export function reviewDestination(kind: string): { sheet: ReviewSheet; action: string } {
  switch (kind) {
    case 'unmatched_label':
      return { sheet: 'expenses', action: 'Match it to a sale, or keep it as an expense' };
    case 'sales_cogs':
    case 'sales_profit':
    case 'sales_revenue':
    case 'hub_profit':
    case 'owner':
    case 'in_store_fee':
      return { sheet: 'sales', action: 'Open these sales' };
    case 'commission':
    case 'sales_commission':
    case 'owed_paul':
    case 'owed_jacob':
    case 'bank_payouts':
    case 'owner_keeps':
      return { sheet: 'payouts', action: 'Open payouts' };
    case 'expenses_total':
      return { sheet: 'expenses', action: 'Open expenses' };
    case 'inventory_flow':
      return { sheet: 'inventory', action: 'Open inventory' };
    default:
      return { sheet: 'sales', action: 'Open these sales' };
  }
}

function ticketKey(row: Row) {
  return String(row.ticket_id || row.ticket_key || `sale:${row.id}`);
}

function salesByIds(workbook: BooksWorkbook, ids: Set<string>) {
  return workbook.sales.rows.filter((row) => ids.has(row.sale_id));
}

/** Sales on a ticket that still has a line with no recorded cost. Those are what throw the row and summary totals apart. */
export function salesBehindCostGap(report: Report | undefined, workbook: BooksWorkbook): SalesLine[] {
  const groups = new Map<string, Row[]>();
  for (const row of report?.sales || []) {
    const key = ticketKey(row);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }
  const ids = new Set<string>();
  for (const lines of groups.values()) {
    if (!lines.some((line) => effectiveCostCents(line) == null)) continue;
    for (const line of lines) ids.add(String(line.id));
  }
  return salesByIds(workbook, ids);
}

function salesOnTicket(report: Report | undefined, workbook: BooksWorkbook, ticketKeyValue: string) {
  const ids = new Set(
    (report?.sales || [])
      .filter((row) => ticketKey(row) === ticketKeyValue)
      .map((row) => String(row.id)),
  );
  const hit = salesByIds(workbook, ids);
  if (hit.length) return hit;
  return workbook.sales.rows.filter((row) => row.sale_id === ticketKeyValue);
}

function skuFromTitle(title: string) {
  const match = title.match(/\bSKU\s+([A-Za-z0-9-]+)/i);
  return match?.[1] || '';
}

function labelFor(report: Report | undefined, id: string, title: string, date: string, amount: number): ReviewLabel {
  const expense = (report?.expenses || []).find((row) => String(row.id) === id);
  const label = (report?.labels || []).find((row) => String(row.id) === id);
  const text = `${title} ${String(expense?.description || '')}`;
  const sku = String(expense?.sku || label?.sku || skuFromTitle(text));
  const carrierRaw = String(label?.carrier || '');
  const carrier = carrierRaw
    || (text.toLowerCase().includes('mercari') ? 'Mercari' : text.toLowerCase().includes('ebay') ? 'eBay' : '');
  const suggested = (report?.sales || []).find((sale) => sku && String(sale.sku) === sku);
  return {
    id,
    date: date || String(expense?.date || expense?.spent_on || label?.date || '').slice(0, 10),
    amount_cents: amount,
    title: title || String(expense?.description || 'Shipping label'),
    source: String(expense?.source || (label ? 'shipping label' : '')),
    carrier,
    tracking: String(label?.tracking_number || ''),
    orderId: String(expense?.order_id || label?.order_id || ''),
    sku,
    suggestedSaleId: suggested ? String(suggested.id) : '',
  };
}

export function listBookIssues(workbook: BooksWorkbook, report?: Report): ReviewIssue[] {
  const out: ReviewIssue[] = [];
  const gapSales = salesBehindCostGap(report, workbook);
  const unmatched = report?.books_unmatched_labels || [];
  if (workbook.integrity && !workbook.integrity.ok) {
    workbook.integrity.issues.forEach((issue, index) => {
      const dest = reviewDestination(issue.kind);
      const sales = issue.kind === 'in_store_fee' && issue.saleId
        ? salesOnTicket(report, workbook, issue.saleId)
        : (issue.kind === 'owner' || issue.kind === 'commission' ? gapSales : []);
      const found = issue.kind === 'unmatched_label'
        ? unmatched.find((row) => row.id === issue.saleId) || unmatched[index]
        : undefined;
      out.push({
        id: `${issue.kind}-${issue.saleId || index}`,
        kind: issue.kind,
        message: issue.message,
        sheet: dest.sheet,
        action: dest.action,
        sales,
        label: found ? labelFor(report, found.id, found.title, found.date, found.amount_cents) : undefined,
      });
    });
  }
  for (const tie of workbook.exportTieIssues || []) {
    const dest = reviewDestination(tie.check);
    const sales = tie.check === 'sales_cogs' || tie.check === 'sales_profit' || tie.check === 'hub_profit' || tie.check === 'owner_keeps'
      ? gapSales
      : [];
    out.push({
      id: tie.check,
      kind: tie.check,
      message: tie.message,
      sheet: dest.sheet,
      action: dest.action,
      sales,
    });
  }
  return out;
}
