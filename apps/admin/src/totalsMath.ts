// Inventory totals row (supabase inventory_totals(), 20261031200000). All numbers are UNITS (qty_on_hand), not rows.
export type InventoryTotalsData = { total: number; listed: number; not_listed: number; defective: number; dns?: number; not_ready?: number };
export type InventoryBucket = 'total' | 'listed' | 'not_listed' | 'not_ready' | 'dns' | 'defective';
export const INVENTORY_BUCKET_LABELS: Record<InventoryBucket, string> = {
  total: 'Total inventory', listed: 'Listed', not_listed: 'Not listed', not_ready: 'Not ready to list',
  dns: 'DNS — Do not ship', defective: 'Defective / not sellable',
};
export function inventoryBucketStatus(bucket: InventoryBucket): string {
  return bucket === 'dns' || bucket === 'defective' ? bucket : `inventory_${bucket}`;
}

/** Listed + Not listed + DNS + Defective must always equal Total. */
export function totalsBalance(t: InventoryTotalsData): boolean {
  return t.listed + t.not_listed + t.defective + (t.dns || 0) + (t.not_ready || 0) === t.total;
}
