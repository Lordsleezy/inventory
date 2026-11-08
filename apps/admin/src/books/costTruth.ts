import type { Row } from './types';

/** Legacy category defaults retired Oct 2026 — not real costs for Books or payouts. */
export const LEGACY_DEFAULT_COST_CENTS = new Set([500, 900, 25000, 30000, 300000]);

export function isRealUnitCost(row: Row): boolean {
  if (row.cost_cents == null || row.cost_cents === '') return false;
  const src = String(row.cost_source || '').toLowerCase();
  if (['default', 'builtin', 'estimated', 'missing', 'category_default'].includes(src)) return false;
  const cents = Number(row.cost_cents);
  if (!Number.isFinite(cents)) return false;
  if (src === 'collectible' && cents === 0) return true;
  if (LEGACY_DEFAULT_COST_CENTS.has(cents) && src !== 'recorded' && src !== 'confirmed') {
    if (row.cost_confirmed_at || row.payout_cost_confirmed_at) return true;
    return false;
  }
  return true;
}

export function effectiveCostCents(row: Row): number | null {
  return isRealUnitCost(row) ? Number(row.cost_cents) : null;
}

export function scrubSaleRow<T extends Row>(row: T): T {
  const cost = effectiveCostCents(row);
  if (cost === null) {
    return { ...row, cost_cents: null, profit_cents: null };
  }
  return { ...row, cost_cents: cost };
}

export function listPlaceholderCostSales(sales: Row[] = []) {
  return sales
    .filter((s) => !s.voided_at && !isRealUnitCost(s))
    .map((s) => ({
      sale_id: String(s.id ?? ''),
      date: String(s.sold_at || s.date || '').slice(0, 10),
      sku: String(s.sku || ''),
      channel: String(s.channel || ''),
      shown_cost_cents: s.cost_cents == null ? null : Number(s.cost_cents),
      cost_source: String(s.cost_source || ''),
    }));
}
