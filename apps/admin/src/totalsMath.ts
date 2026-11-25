// Inventory totals (inventory_totals()). Total / ready / not-ready / DNS / defective are
// physical pieces (qty_on_hand). Listed is eBay listing count (one per in-stock SKU live
// on the selling account). listed_pieces is the qty behind those listings for balance math.
export type InventoryTotalsData = {
  total: number;
  listed: number;
  listed_pieces?: number;
  not_listed: number;
  not_listed_skus?: number;
  not_listed_pieces?: number;
  defective: number;
  dns?: number;
  not_ready?: number;
  never_list?: number;
};
export type InventoryBucket = 'total' | 'listed' | 'not_listed' | 'not_ready' | 'dns' | 'defective';
export const INVENTORY_BUCKET_LABELS: Record<InventoryBucket, string> = {
  total: 'Total inventory', listed: 'Listed', not_listed: 'Not listed', not_ready: 'Not ready to list',
  dns: 'DNS — Do not ship', defective: 'Defective / not sellable',
};
export function inventoryBucketStatus(bucket: InventoryBucket): string {
  return bucket === 'dns' || bucket === 'defective' ? bucket : `inventory_${bucket}`;
}

/** Physical pieces behind every bucket must equal Total inventory. */
export function totalsBalance(t: InventoryTotalsData): boolean {
  const listedPieces = t.listed_pieces ?? t.listed;
  return listedPieces + t.not_listed + t.defective + (t.dns || 0) + (t.not_ready || 0) + (t.never_list || 0) === t.total;
}
