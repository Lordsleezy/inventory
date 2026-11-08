import type { BookTotals, Report, Row } from './types';

const TEST_NOTE = /\b(test|smoke|demo|live check)\b/i;

export const monthLabel = (s: string) => new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${s}T12:00:00Z`));

export function channelTitle(value: unknown) {
  const raw = String(value ?? '').toLowerCase();
  if (['floor', 'in_store', 'instore', 'store'].includes(raw)) return 'In-store';
  return ({ ebay: 'eBay', depop: 'Depop', website: 'Website', amazon: 'Amazon', tiktok: 'TikTok', mercari: 'Mercari', square: 'Square', safe: 'Safe cash' } as Record<string, string>)[raw] || String(value ?? '');
}

export function cleanBookRows(rows: Row[] = []) {
  return rows.filter((row) => !['note', 'description', 'void_reason', 'transaction_memo', 'reason'].some((key) => typeof row[key] === 'string' && TEST_NOTE.test(String(row[key]))));
}

export function allocateTicketPayments(rows: Row[]): Row[] {
  const result = rows.map((row) => ({ ...row }));
  const groups = new Map<string, number[]>();
  result.forEach((row, index) => { const ticket = String(row.ticket_id || ''); if (ticket) groups.set(ticket, [...(groups.get(ticket) || []), index]); });
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    const totals = { cash_cents: Math.max(...indexes.map((i) => Number(result[i].cash_cents || 0))), card_cents: Math.max(...indexes.map((i) => Number(result[i].card_cents || 0))) };
    const weights = indexes.map((i) => Math.max(0, Number(result[i].price_cents || 0) + Number(result[i].tax_collected_cents ?? result[i].tax_cents ?? 0)));
    const equal = weights.every((x) => x === 0); const sum = weights.reduce((a, b) => a + b, 0) || indexes.length;
    for (const key of ['cash_cents', 'card_cents'] as const) {
      const total = totals[key]; const allocated = weights.map((w) => Math.floor(total * (equal ? 1 : w) / sum));
      let remainder = total - allocated.reduce((a, b) => a + b, 0); for (let i = 0; remainder > 0; i = (i + 1) % allocated.length, remainder--) allocated[i]++;
      indexes.forEach((index, i) => { result[index][key] = allocated[i]; });
    }
  }
  return result;
}

export function applySquareMatchedFees(sales: Row[], payments: Row[] = []) {
  const result = sales.map((sale) => ({ ...sale }));
  const indexById = new Map(result.map((sale, index) => [String(sale.id), index]));
  for (const payment of payments.filter((row) => row.match_status === 'matched' && Array.isArray(row.sale_ids))) {
    const indexes = (payment.sale_ids as unknown[]).map((id) => indexById.get(String(id))).filter((index): index is number => index !== undefined);
    if (!indexes.length) continue;
    const fee = Math.max(0, Number(payment.fee_cents || 0));
    const weights = indexes.map((index) => Math.max(0, Number(result[index].price_cents || 0) + Number(result[index].tax_collected_cents ?? result[index].tax_cents ?? 0)));
    const total = weights.reduce((sum, value) => sum + value, 0) || indexes.length;
    const shares = weights.map((weight) => Math.floor(fee * (weights.every((value) => value === 0) ? 1 : weight) / total));
    let remainder = fee - shares.reduce((sum, value) => sum + value, 0);
    for (let i = 0; remainder > 0; i = (i + 1) % shares.length, remainder--) shares[i]++;
    indexes.forEach((index, i) => {
      const priorFee = Number(result[index].processing_fee_cents || 0);
      result[index].processing_fee_cents = shares[i];
      result[index].processing_fee_source = 'actual';
      if (typeof result[index].profit_cents === 'number') result[index].profit_cents = Number(result[index].profit_cents) + priorFee - shares[i];
    });
  }
  return result;
}

export function normalizeReport(raw: Report): Report {
  const next = { ...raw };
  for (const key of ['sales', 'fees', 'labels', 'expenses', 'returns', 'dispositions', 'inventory_bought', 'manifests', 'payouts', 'payout_balances', 'payments', 'adjustments', 'prior_corrections', 'withdrawals', 'money_trail'] as const) {
    next[key] = cleanBookRows((raw[key] || []) as Row[]);
  }
  next.sales = applySquareMatchedFees(
    allocateTicketPayments((next.sales || []).map((sale) => Number(sale.cost_cents) === 900 ? { ...sale, cost_source: 'default' } : sale)),
    raw.square_payments || [],
  );
  return next;
}

/**
 * Single source of truth for Books month summary (hub card, sales sheet, exports).
 * Uses normalizeReport (Square matched card fees + ticket payment split). Older period
 * cards summed raw sale_ledger profit_cents and overstated profit by ~$76 on Oct 2026.
 */
export function computeBookTotals(report: Report): BookTotals {
  const sales = report.sales || [];
  const fees = (report.fees || []).reduce((n, f) => n + Number(f.amount_cents || 0), 0);
  const labelCostsOnSales = sales.reduce((n, r) => n + Number(r.ship_cost_cents || 0), 0);
  const expense = (report.expenses || []).filter((r) => !r.voided_at).reduce((n, r) => n + Number(r.amount_cents || 0), 0);
  const commission = (report.payouts || []).reduce((n, r) => n + Number(r.amount_cents || 0), 0);
  return {
    revenue: sales.reduce((n, r) => n + Number(r.price_cents || 0) + Number(r.shipping_cents || 0), 0),
    cost: sales.reduce((n, r) => n + Number(r.cost_cents || 0), 0),
    fees,
    labelCostsOnSales,
    feesAndLabels: fees + labelCostsOnSales,
    commission,
    profit: sales.reduce((n, r) => n + Number(r.profit_cents || 0), 0),
    expense,
  };
}

/** October 2026 sanity targets from the legacy Books summary (cents). */
export const OCTOBER_2026_TARGETS = {
  period_start: '2026-10-01',
  sales_cents: 823691,
  cost_cents: 209150,
  fees_labels_cents: 80645,
  commission_cents: 176611,
  profit_cents: 550109,
} as const;

export function formatSanityLine(totals: BookTotals) {
  return `sales ${(totals.revenue / 100).toFixed(2)} | COGS ${(totals.cost / 100).toFixed(2)} | fees+labels ${(totals.feesAndLabels / 100).toFixed(2)} | commission ${(totals.commission / 100).toFixed(2)} | profit ${(totals.profit / 100).toFixed(2)}`;
}
