/**
 * Acquisition cost typed in dollars, same rules as the item editor cost box.
 * null = blank. undefined = not a dollar amount (letters, extra decimals, negative).
 * 0 is a real cost (free items).
 */
export function acquisitionCostCents(input: string): number | null | undefined {
  const text = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!text) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Blank and non-numeric amounts stay on the row and are not saved. */
export function missingCostSubmitError(input: string): string | null {
  const cents = acquisitionCostCents(input);
  if (cents === null) return 'Enter a cost before submitting.';
  if (cents === undefined) return 'Cost must be a number like 12.50.';
  return null;
}

export type MissingCostSource = {
  sku: string;
  brand?: string;
  model?: string;
  title?: string;
  state: string;
  sold_at?: string | null;
  acquisition_cost_cents?: number | null;
  defective?: boolean;
  not_for_sale?: boolean;
  group_members?: MissingCostSource[];
};

/**
 * Same units the inventory list already shows on In stock and Sold, with no acquisition cost.
 * Sold stays even when DNS or defective (those rows are on the Sold chip).
 * In-stock defective and do-not-list stay out — they are not on In stock.
 * In-stock DNS (do not ship) stays, because In stock already shows it.
 */
export function includeMissingCostUnit(unit: Pick<MissingCostSource, 'state' | 'acquisition_cost_cents' | 'defective' | 'not_for_sale'>): boolean {
  if (unit.acquisition_cost_cents != null) return false;
  if (unit.state === 'sold') return true;
  if (unit.defective || unit.not_for_sale) return false;
  return unit.state === 'available' || unit.state === 'reserved' || unit.state === 'repair';
}

/** Sold missing cost first (most recently sold), then the rest by SKU descending. */
export function compareMissingCost(a: Pick<MissingCostSource, 'sku' | 'state' | 'sold_at'>, b: Pick<MissingCostSource, 'sku' | 'state' | 'sold_at'>): number {
  const rank = (state: string) => state === 'sold' ? 0 : 1;
  const byRank = rank(a.state) - rank(b.state);
  if (byRank) return byRank;
  if (a.state === 'sold') {
    const bySold = String(b.sold_at || '').localeCompare(String(a.sold_at || ''));
    if (bySold) return bySold;
  }
  const aSku = Number(a.sku);
  const bSku = Number(b.sku);
  if (Number.isFinite(aSku) && Number.isFinite(bSku) && aSku !== bSku) return bSku - aSku;
  return String(b.sku).localeCompare(String(a.sku));
}

/**
 * One inventory page, missing cost already sorted first.
 * A representative that has a cost means later pages are costed too.
 * Members of that row can still be missing a cost, so they are kept.
 */
export function takeMissingCostPage<T extends MissingCostSource>(items: T[]): { units: T[]; done: boolean } {
  const units: T[] = [];
  const seen = new Set<string>();
  let done = items.length === 0;
  for (const item of items) {
    if (item.acquisition_cost_cents != null) done = true;
    const members = item.group_members?.length ? item.group_members : [item];
    for (const member of members) {
      if (!includeMissingCostUnit(member)) continue;
      if (seen.has(member.sku)) continue;
      seen.add(member.sku);
      units.push(member as T);
    }
  }
  return { units, done };
}

export function mergeMissingCost<T extends MissingCostSource>(groups: T[][]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const unit of groups.flat().sort(compareMissingCost)) {
    if (seen.has(unit.sku)) continue;
    seen.add(unit.sku);
    out.push(unit);
  }
  return out;
}

/** Phone inventory chips. Missing cost is last so the row scrolls to it. */
export function inventoryChipLabels(args: { noLocation: number; missingCost: number | null; showMissingCost: boolean }): [string, string][] {
  const chips: [string, string][] = [
    ['in_stock', 'In stock'],
    ['sold', 'Sold'],
    ['needs_check', 'Needs check'],
    ['no_location', `No location ${args.noLocation}`],
  ];
  if (args.showMissingCost) {
    chips.push(['missing_cost', args.missingCost == null ? 'Missing cost' : `Missing cost ${args.missingCost}`]);
  }
  return chips;
}
