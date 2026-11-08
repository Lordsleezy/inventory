import { channelTitle, computeBookTotals } from './booksMath';
import { saleWhyText } from './saleNotes';
import type { BooksWorkbook, ExpenseLine, InventorySummary, ReceivedItem, Report, Row, SalesLine } from './types';

function promotedFeesForSale(report: Report, saleId: string | number) {
  return (report.fees || []).filter((f) => {
    if (String(f.sale_id ?? '') !== String(saleId)) return false;
    const t = String(f.type || '').toLowerCase();
    return t.includes('promoted') || t.includes('ad');
  }).reduce((n, f) => n + Number(f.amount_cents || 0), 0);
}


function commissionCents(row: Row) {
  if (Array.isArray(row.commission_breakdown) && row.commission_breakdown.length) {
    const parts = row.commission_breakdown as Row[];
    if (parts.some((p) => p.amount_cents == null)) return null;
    return parts.reduce((n, p) => n + Number(p.amount_cents || 0), 0);
  }
  const paul = row.paul_commission_cents; const jacob = row.jacob_commission_cents;
  if (paul == null && jacob == null) return null;
  return Number(paul || 0) + Number(jacob || 0);
}

function expenseRows(report: Report): ExpenseLine[] {
  const rows: ExpenseLine[] = [];
  const labelIdsInExpenses = new Set((report.expenses || []).map((e) => String(e.label_id || '')).filter(Boolean));
  const returnExpenseKeys = new Set(
    (report.expenses || [])
      .filter((e) => String(e.source || '').toLowerCase() === 'return')
      .map((e) => String(e.external_id || e.id || ''))
      .filter(Boolean),
  );

  for (const e of (report.expenses || []).filter((x) => !x.voided_at)) {
    rows.push({
      date: String(e.date ?? e.spent_on ?? ''),
      category: String(e.category || 'Other'),
      description: String(e.description || ''),
      amount_cents: Number(e.amount_cents || 0),
      sku_or_order: String(e.sku || e.order_id || e.external_id || ''),
      paid_by: String(e.source || 'manual'),
      needs_reimbursement: e.needs_reimbursement ? 'Yes' : 'No',
      source: String(e.source || 'manual'),
    });
  }

  for (const l of report.labels || []) {
    if (labelIdsInExpenses.has(String(l.id))) continue;
    const cents = Number(l.signed_amount_cents ?? l.cost_cents ?? 0);
    if (!cents) continue;
    rows.push({
      date: String(l.date || '').slice(0, 10),
      category: 'Shipping labels',
      description: [l.carrier, l.service, l.tracking_number].filter(Boolean).join(' · ') || 'Shipping label',
      amount_cents: Math.abs(cents),
      sku_or_order: String(l.order_id || l.transaction_id || ''),
      paid_by: 'Store',
      needs_reimbursement: 'No',
      source: 'label',
    });
  }

  const saleIds = new Set((report.sales || []).map((s) => String(s.id)));
  for (const f of report.fees || []) {
    const type = String(f.type || '').toLowerCase();
    if (!type.includes('promoted') && !type.includes('ad')) continue;
    if (f.sale_id && saleIds.has(String(f.sale_id))) continue;
    rows.push({
      date: String(f.date || '').slice(0, 10),
      category: 'Promoted listings',
      description: String(f.type || 'Marketplace fee'),
      amount_cents: Number(f.amount_cents || 0),
      sku_or_order: String(f.sku || f.order_id || ''),
      paid_by: String(f.channel || ''),
      needs_reimbursement: 'No',
      source: 'fee',
    });
  }

  for (const r of report.returns || []) {
    const key = `return-label:${r.id}`;
    if (returnExpenseKeys.has(key) || returnExpenseKeys.has(String(r.id))) continue;
    const labelCents = Number(r.return_label_cents || 0);
    if (labelCents <= 0 || String(r.label_paid_by || 'seller') !== 'seller') continue;
    rows.push({
      date: String(r.created_at || r.date || '').slice(0, 10),
      category: 'Returns',
      description: `Return label ${String(r.channel || '').toUpperCase()} SKU ${r.sku}`,
      amount_cents: labelCents,
      sku_or_order: String(r.sku || r.external_order_id || ''),
      paid_by: 'Store',
      needs_reimbursement: 'No',
      source: 'return',
    });
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category));
  return rows;
}

function salesRows(report: Report): SalesLine[] {
  return (report.sales || []).map((row) => {
    const promoted = promotedFeesForSale(report, row.id as string | number);
    const marketplace = Number(row.channel_fee_cents || 0) + Number(row.final_value_fee_cents || 0) + promoted;
    return {
      sale_id: String(row.id ?? ''),
      date: String(row.sold_at || row.date || '').slice(0, 10),
      sku: String(row.sku || ''),
      title: String(row.item_title || row.title || row.sku || ''),
      channel: channelTitle(row.channel),
      order_no: String(row.receipt_no || row.order_id || ''),
      qty: Number(row.qty || 1),
      price_cents: Number(row.price_cents || 0),
      tax_cents: Number(row.tax_collected_cents ?? row.tax_cents ?? 0),
      marketplace_fees_cents: marketplace,
      card_fees_cents: Number(row.processing_fee_cents || row.payment_fee_cents || 0),
      buyer_shipping_cents: Number(row.shipping_cents || 0),
      label_cost_cents: Number(row.ship_cost_cents || 0),
      cost_cents: row.cost_cents == null ? null : Number(row.cost_cents),
      profit_cents: row.profit_cents == null ? null : Number(row.profit_cents),
      commission_cents: commissionCents(row),
      profit_notes: saleWhyText(row, report),
    };
  });
}

export function buildBooksWorkbook(report: Report, inventory: InventorySummary, received: ReceivedItem[]): BooksWorkbook {
  const expenses = expenseRows(report);
  const byCat = new Map<string, number>();
  for (const e of expenses) byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount_cents);
  const categoryTotals = [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, amount_cents]) => ({ category, amount_cents }));

  const sales = salesRows(report);
  const totals = computeBookTotals(report);
  const ch = new Map<string, { revenue_cents: number; profit_cents: number; count: number }>();
  for (const s of sales) {
    const key = s.channel;
    const item = ch.get(key) || { revenue_cents: 0, profit_cents: 0, count: 0 };
    item.revenue_cents += s.price_cents + s.buyer_shipping_cents;
    item.profit_cents += s.profit_cents ?? 0;
    item.count += s.qty;
    ch.set(key, item);
  }
  const channelTotals = [...ch.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([channel, v]) => ({ channel, ...v }));

  return {
    expenses: { rows: expenses, categoryTotals, total_cents: expenses.reduce((n, e) => n + e.amount_cents, 0) },
    sales: { rows: sales, channelTotals, totals },
    inventory,
    received,
  };
}

export function groupExpensesByCategory(rows: ExpenseLine[]) {
  const groups = new Map<string, ExpenseLine[]>();
  for (const e of rows) {
    const list = groups.get(e.category) || [];
    list.push(e);
    groups.set(e.category, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function receivedMonthStats(items: ReceivedItem[]) {
  let units = 0;
  let costCents = 0;
  for (const r of items) {
    const qty = Math.max(1, Number(r.qty_on_hand || 1));
    units += qty;
    const unitCost = Number(r.cost_cents || 0);
    costCents += unitCost * qty;
  }
  return { units, skus: items.length, cost_cents: costCents };
}

export function groupReceivedByDay(items: ReceivedItem[]) {
  const groups = new Map<string, ReceivedItem[]>();
  for (const r of items) {
    const day = String(r.received_at || '').slice(0, 10);
    const list = groups.get(day) || [];
    list.push(r);
    groups.set(day, list);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
}
