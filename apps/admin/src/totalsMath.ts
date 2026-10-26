// Inventory totals row (supabase inventory_totals(), 20261031200000). All numbers are UNITS (qty_on_hand), not rows.
export type InventoryTotalsData = { total: number; listed: number; not_listed: number; defective: number; dns?: number };

/** Listed + Not listed + DNS + Defective must always equal Total. */
export function totalsBalance(t: InventoryTotalsData): boolean {
  return t.listed + t.not_listed + t.defective + (t.dns || 0) === t.total;
}
