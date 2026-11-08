import { storeCheckoutLabel } from './expenseBuild';
import type { Report, Row } from './types';

export type UnmatchedLabel = {
  id: string;
  date: string;
  amount_cents: number;
  title: string;
};

/** Fee rows from Books report that are not yet in sale_ledger profit. */
export type SaleFeeExtra = { promoted_cents: number; label_extra_cents: number; channel_extra_cents: number };

export function saleFeeExtras(row: Row): SaleFeeExtra {
  const x = row.books_fee_extra as SaleFeeExtra | undefined;
  return x || { promoted_cents: 0, label_extra_cents: 0, channel_extra_cents: 0 };
}

function normOrder(v: unknown) {
  return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

function saleOrderKeys(s: Row): string[] {
  const keys = new Set<string>();
  for (const raw of [s.receipt_no, s.order_id, s.web_order_no, s.order_no]) {
    const n = normOrder(raw);
    if (n) keys.add(n);
  }
  return [...keys];
}

function feeAlreadyOnSale(s: Row, f: Row, amount: number): boolean {
  const kind = String(f.type || '').toLowerCase();
  if (kind === 'channel_fee' || kind.includes('final value')) {
    return Math.abs(Number(s.channel_fee_cents || 0) - amount) < 2;
  }
  if (kind.includes('payment') || kind.includes('processing')) {
    return Math.abs(Number(s.processing_fee_cents || 0) - amount) < 2;
  }
  return false;
}

function applyFee(s: Row, f: Row, amount: number) {
  if (amount === 0 || feeAlreadyOnSale(s, f, amount)) return;
  const kind = String(f.type || '').toLowerCase();
  const memo = String(f.memo || f.type || '').toLowerCase();
  const extra = saleFeeExtras(s);
  if (kind.includes('promoted') || kind.includes('ad') || memo.includes('promoted')) {
    extra.promoted_cents += amount;
    if (s.profit_cents != null) s.profit_cents = Number(s.profit_cents) - amount;
  } else if (
    kind.includes('underpaid')
    || kind.includes('postage')
    || memo.includes('underpaid')
    || memo.includes('postage')
    || (kind.includes('shipping') && f.order_id)
  ) {
    extra.label_extra_cents += amount;
    s.ship_cost_cents = Number(s.ship_cost_cents || 0) + amount;
    if (s.profit_cents != null) s.profit_cents = Number(s.profit_cents) - amount;
  } else if (kind.includes('payment') || kind.includes('processing')) {
    const prior = Number(s.processing_fee_cents || 0);
    s.processing_fee_cents = prior + amount;
    if (s.profit_cents != null) s.profit_cents = Number(s.profit_cents) - amount;
  } else if (f.sale_id || f.order_id) {
    extra.channel_extra_cents += amount;
    s.channel_fee_cents = Number(s.channel_fee_cents || 0) + amount;
    if (s.profit_cents != null) s.profit_cents = Number(s.profit_cents) - amount;
  }
  s.books_fee_extra = extra;
}

/**
 * Attach order-linked fees (underpaid postage, promoted listing charges, etc.)
 * to the matching sale so profit and the Sales sheet stay aligned with Expenses.
 */
export function applySaleFeeAdjustments(report: Report): Report {
  const sales = (report.sales || []).map((s) => ({ ...s }));
  const byId = new Map<string, number>();
  const byOrder = new Map<string, number>();
  sales.forEach((s, i) => {
    byId.set(String(s.id), i);
    for (const key of saleOrderKeys(s)) byOrder.set(key, i);
  });

  const attributedFeeIds = new Set<string>();
  for (const f of report.fees || []) {
    const amount = Number(f.amount_cents || 0);
    if (!amount) continue;
    const id = String(f.id || '');
    let idx: number | undefined;
    if (f.sale_id != null && byId.has(String(f.sale_id))) idx = byId.get(String(f.sale_id));
    else {
      const order = normOrder(f.order_id);
      if (order && byOrder.has(order)) idx = byOrder.get(order);
    }
    if (idx == null) continue;
    applyFee(sales[idx], f, amount);
    if (id) attributedFeeIds.add(id);
  }
  return { ...report, sales, books_attributed_fee_ids: [...attributedFeeIds] };
}

function saleIndexMaps(sales: Row[]) {
  const byId = new Map<string, number>();
  const byOrder = new Map<string, number>();
  const bySku = new Map<string, number[]>();
  sales.forEach((s, i) => {
    byId.set(String(s.id), i);
    for (const key of saleOrderKeys(s)) byOrder.set(key, i);
    const sku = String(s.sku || '').trim();
    if (sku) bySku.set(sku, [...(bySku.get(sku) || []), i]);
  });
  return { byId, byOrder, bySku };
}

function pickSaleIndex(
  sales: Row[],
  maps: ReturnType<typeof saleIndexMaps>,
  opts: { saleId?: unknown; orderId?: unknown; sku?: unknown; channel?: string },
): number | undefined {
  if (opts.saleId != null && maps.byId.has(String(opts.saleId))) return maps.byId.get(String(opts.saleId));
  const order = normOrder(opts.orderId);
  if (order && maps.byOrder.has(order)) return maps.byOrder.get(order);
  const sku = String(opts.sku || '').trim();
  if (!sku) return undefined;
  const hits = maps.bySku.get(sku) || [];
  const ch = String(opts.channel || '').toLowerCase();
  const filtered = ch ? hits.filter((i) => String(sales[i].channel || '').toLowerCase() === ch) : hits;
  return filtered[0] ?? hits[0];
}

/** Attach out-of-pocket label costs to matching sales so profit and commission match other channels. */
export function applySaleLabelCosts(report: Report): Report {
  const sales = (report.sales || []).map((s) => ({ ...s }));
  const maps = saleIndexMaps(sales);
  const dedupExpenseIds = new Set<string>();
  const dedupLabelIds = new Set<string>();
  const unmatched: UnmatchedLabel[] = [];
  const pushUnmatched = (id: string, date: string, cents: number, title: string) => {
    unmatched.push({ id, date: String(date || '').slice(0, 10), amount_cents: cents, title });
  };

  const addShip = (idx: number, cents: number) => {
    if (cents <= 0) return;
    sales[idx].ship_cost_cents = Number(sales[idx].ship_cost_cents || 0) + cents;
    if (sales[idx].profit_cents != null) sales[idx].profit_cents = Number(sales[idx].profit_cents) - cents;
  };

  for (const l of report.labels || []) {
    if (l.voided_at) continue;
    if (storeCheckoutLabel({}, l)) continue;
    const cents = Math.abs(Number(l.signed_amount_cents ?? l.cost_cents ?? 0));
    if (!cents) continue;
    const order = String(l.order_id || l.transaction_id || '');
    const title = String(l.carrier || '').toLowerCase() === 'ebay'
      ? `eBay label${order ? ` · ${order}` : ''}`
      : ['Shipping label', order].filter(Boolean).join(' · ');
    const idx = pickSaleIndex(sales, maps, { orderId: l.order_id || l.transaction_id, sku: l.sku, channel: String(l.carrier || '') });
    if (idx == null) {
      pushUnmatched(String(l.id), String(l.date || l.purchased_at || ''), cents, title);
      continue;
    }
    const already = Number(sales[idx].ship_cost_cents || 0);
    if (already >= cents) {
      dedupLabelIds.add(String(l.id));
      continue;
    }
    addShip(idx, cents - already);
    dedupLabelIds.add(String(l.id));
  }

  for (const e of report.expenses || []) {
    if (e.voided_at) continue;
    const src = String(e.source || '').toLowerCase();
    if (src !== 'label' && src !== 'manual_label') continue;
    if (!e.needs_reimbursement) continue;
    const cents = Number(e.amount_cents || 0);
    if (!cents) continue;
    const idx = pickSaleIndex(sales, maps, { saleId: e.sale_id, orderId: e.order_id, sku: e.sku, channel: String(e.channel || e.source || '') });
    if (idx == null) {
      pushUnmatched(String(e.id), String(e.spent_on || e.date || ''), cents, String(e.description || 'Shipping label'));
      continue;
    }
    if (Number(sales[idx].ship_cost_cents || 0) < cents) addShip(idx, cents - Number(sales[idx].ship_cost_cents || 0));
    dedupExpenseIds.add(String(e.id));
  }

  return {
    ...report,
    sales,
    books_label_dedup_expense_ids: [...dedupExpenseIds],
    books_label_dedup_label_ids: [...dedupLabelIds],
    books_unmatched_labels: unmatched,
  };
}

export function promotedOnSales(report: Report): Set<string> {
  const ids = new Set<string>();
  for (const f of report.fees || []) {
    const type = String(f.type || '').toLowerCase();
    if (!type.includes('promoted') && !type.includes('ad')) continue;
    if (f.sale_id) ids.add(String(f.id || `${f.sale_id}:${f.date}`));
  }
  return ids;
}
