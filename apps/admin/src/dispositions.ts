// Replacements and giveaways: units that leave the store without a sale (supabase 20261031100000).
// Pure helpers so the rules the UI relies on can be tested.

export type DispositionKind = 'replacement' | 'giveaway';

export type Disposition = {
  id: string; kind: DispositionKind; sku: string; item: string;
  cost_cents: number | null; extra_cost_cents: number; cost_missing: boolean;
  original_sale_id: number | null; original_sku: string | null; original_receipt_no: string | null;
  original_channel: string | null; original_sold_at: string | null;
  bad_unit_status: 'returned' | 'pending' | null; bad_unit_sku: string | null;
  given_to: string | null; note: string | null; expense_id: string | null;
  recorded_by_name: string | null; created_at: string;
  undone_at: string | null; undone_by_name: string | null;
};

export type SaleHit = {
  sale_id: number; receipt_no: string; sku: string; item: string; channel: string; sold_at: string;
  price_cents: number; order_ref: string | null; buyer: string | null; replacements: number;
};

/** Only admins (portal owner/manager) get the buttons, and only on in-stock units. The server enforces it too. */
export function showDispositionButtons(opts: { isAdmin: boolean; associateBrowseOnly?: boolean; inStock: boolean }): boolean {
  return opts.isAdmin && !opts.associateBrowseOnly && opts.inStock;
}

/** "12.50" -> 1250. Blank is 0 (optional field). Returns null for anything that is not a non-negative amount. */
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/^\$/, '');
  if (t === '') return 0;
  if (!/^\d*(?:\.\d{0,2})?$/.test(t) || t === '.') return null;
  return Math.round(Number(t) * 100);
}

/** Cost shown for a unit that left: never a guess, "cost missing" until one is entered. */
export function costLabel(d: Pick<Disposition, 'cost_cents' | 'extra_cost_cents' | 'cost_missing'>, money: (n: number) => string): string {
  if (d.cost_missing || d.cost_cents == null) return 'cost missing';
  const total = d.cost_cents + (d.extra_cost_cents || 0);
  return d.extra_cost_cents ? `${money(total)} (${money(d.cost_cents)} + ${money(d.extra_cost_cents)} extra)` : money(total);
}

/** One line for the original sale: "Replacement sent: SKU 12345, cost $15.00, Oct 25". */
export function replacementLine(d: Disposition, money: (n: number) => string, stamp: (s: string) => string): string {
  return `Replacement sent: SKU ${d.sku}, ${d.cost_missing ? 'cost missing' : `cost ${money((d.cost_cents || 0) + (d.extra_cost_cents || 0))}`}, ${stamp(d.created_at)}`;
}

/** Active replacements keyed by the sale they were sent for. */
export function replacementsBySale(rows: Disposition[]): Map<number, Disposition[]> {
  const map = new Map<number, Disposition[]>();
  for (const d of rows) {
    if (d.kind !== 'replacement' || d.undone_at || d.original_sale_id == null) continue;
    map.set(d.original_sale_id, [...(map.get(d.original_sale_id) || []), d]);
  }
  return map;
}

/**
 * Payouts screen: a replacement adjustment on a paid-out sale is a visible ledger line only. The commission already
 * dropped with the sale, so the line is paired with an add-back of the opposite sign (same trick as return clawbacks).
 */
export function replacementAddback(adj: { amount_cents: number; replacement_id?: string | null }): number {
  return adj.replacement_id ? -adj.amount_cents : 0;
}
