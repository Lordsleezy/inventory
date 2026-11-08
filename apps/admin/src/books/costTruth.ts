import type { Row } from './types';

/** Floor unit acquisition cost × qty; falls back to ledger line cost when unit field is absent. */
export function effectiveCostCents(row: Row): number | null {
  const qty = Math.max(1, Number(row.qty || 1));
  const src = String(row.cost_source || '').toLowerCase();
  if (src === 'collectible' || row.is_collectible) return 0;

  const unit = row.unit_cost_cents != null && row.unit_cost_cents !== ''
    ? Number(row.unit_cost_cents)
    : null;
  if (unit != null && unit > 0) return unit * qty;

  const ledger = row.cost_cents != null && row.cost_cents !== '' ? Number(row.cost_cents) : null;
  if (ledger != null && ledger > 0) return ledger;

  return null;
}

export function hasSaleCost(row: Row): boolean {
  return effectiveCostCents(row) !== null;
}

export function enrichSaleCost<T extends Row>(row: T): T {
  return { ...row, cost_cents: effectiveCostCents(row) };
}

/** Sales with no resolvable unit/ledger cost (profit and commission should be blank / $0). */
export function listTrulyMissingCostSales(sales: Row[] = []) {
  return (sales || [])
    .filter((s) => !s.voided_at && effectiveCostCents(s) === null)
    .map((s) => ({
      sale_id: String(s.id ?? ''),
      date: String(s.sold_at || s.date || '').slice(0, 10),
      sku: String(s.sku || ''),
      channel: String(s.channel || ''),
      title: String(s.item_title || s.title || ''),
    }));
}

/** Only sales flagged in sale_payout_cost_flags (provable legacy default), not dollar heuristics. */
export function listFlaggedDefaultCostSales(sales: Row[], flaggedSaleIds: Set<string>) {
  return (sales || [])
    .filter((s) => !s.voided_at && flaggedSaleIds.has(String(s.id)))
    .map((s) => ({
      sale_id: String(s.id ?? ''),
      date: String(s.sold_at || s.date || '').slice(0, 10),
      sku: String(s.sku || ''),
      channel: String(s.channel || ''),
      title: String(s.item_title || s.title || ''),
      ledger_cost_cents: s.cost_cents == null ? null : Number(s.cost_cents),
      unit_cost_cents: s.unit_cost_cents == null ? null : Number(s.unit_cost_cents),
      cost_source: String(s.cost_source || ''),
    }));
}
