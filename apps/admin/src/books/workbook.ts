import { channelTitle, computeBookTotals } from './booksMath';
import { buildExpenses, filterReceived } from './expenseBuild';
import { buildPayouts } from './payoutsBuild';
import { saleFeeExtras } from './saleAdjustments';
import { saleWhyText } from './saleNotes';
import type { BooksWorkbook, ExpenseDisplayLine, InventorySummary, ReceivedItem, Report, Row, SalesLine } from './types';

function promotedFeesForSale(report: Report, saleId: string | number) {
  const attributed = new Set(report.books_attributed_fee_ids || []);
  return (report.fees || []).filter((f) => {
    if (String(f.sale_id ?? '') !== String(saleId)) return false;
    if (attributed.has(String(f.id || ''))) return false;
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

function salesRows(report: Report): SalesLine[] {
  return (report.sales || []).map((row) => {
    const extra = saleFeeExtras(row);
    const promoted = promotedFeesForSale(report, row.id as string | number) + extra.promoted_cents;
    const marketplace = Number(row.channel_fee_cents || 0) + Number(row.final_value_fee_cents || 0) + promoted + extra.channel_extra_cents;
    const label = Number(row.ship_cost_cents || 0);
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
      label_cost_cents: label,
      cost_cents: row.cost_cents == null ? null : Number(row.cost_cents),
      profit_cents: row.profit_cents == null ? null : Number(row.profit_cents),
      commission_cents: commissionCents(row),
      profit_notes: saleWhyText(row, report),
    };
  });
}

export function buildBooksWorkbook(report: Report, inventory: InventorySummary, received: ReceivedItem[]): BooksWorkbook {
  const attributed = new Set(report.books_attributed_fee_ids || []);
  const built = buildExpenses(report, attributed);
  const sales = salesRows(report);
  const totals = computeBookTotals(report, { salesLines: sales, otherExpensesCents: built.otherExpenses_cents });
  const payouts = buildPayouts(report, totals);

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
    expenses: {
      rows: built.rows,
      exportRows: built.exportRows,
      categoryTotals: built.categoryTotals,
      total_cents: built.total_cents,
      reimburse_cents: built.reimburse_cents,
      otherExpenses_cents: built.otherExpenses_cents,
      duplicates: built.duplicates,
    },
    sales: { rows: sales, channelTotals, totals },
    payouts,
    inventory,
    received: filterReceived(received) as ReceivedItem[],
  };
}

export function groupExpensesByCategory(rows: ExpenseDisplayLine[]) {
  const groups = new Map<string, ExpenseDisplayLine[]>();
  for (const e of rows) {
    if (e.children?.length) continue;
    const list = groups.get(e.category) || [];
    list.push(e);
    groups.set(e.category, list);
  }
  for (const e of rows) {
    if (!e.children?.length) continue;
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
