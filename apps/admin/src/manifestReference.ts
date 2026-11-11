export type ManifestReference = {
  received?: number;
  expected?: number;
  qty?: number;
  retail_cents: number;
  manifest_name: string;
  manifest_on: string;
  description?: string;
  brand?: string;
  item_number?: string;
  category?: string;
  seller_category?: string;
  condition?: string;
  warnings: { manifest_name: string; total_qty: number; defective_qty: number; conditions: string[] }[];
};

export type ManifestSearchLine = {
  manifest_id: string;
  manifest_name: string;
  line_number: number;
  upc_raw: string;
  upc_normalized: string;
  description: string;
  brand: string;
  item_number: string;
  category: string;
  seller_category: string;
  qty: number;
  unit_retail_cents: number;
  condition: string;
  expected: number;
  received: number;
};

export function manifestDefectWarnings(reference: ManifestReference): string[] {
  return reference.warnings.map(warning => warning.defective_qty < warning.total_qty
    ? `${warning.defective_qty} of ${warning.total_qty} units of this UPC on the manifest are marked ${warning.conditions.join(', ')}. Check this one.`
    : `Manifest warns an item with this UPC is defective (${warning.conditions.join(', ')}).`);
}

/** Identity line for receive UI — never used for ask/cost. */
export function manifestIdentityLine(reference: Pick<ManifestReference, 'brand' | 'description' | 'item_number'>): string {
  const parts = [reference.brand?.trim(), reference.description?.trim()].filter(Boolean);
  if (reference.item_number?.trim()) parts.push(`#${reference.item_number.trim()}`);
  return parts.join(' · ');
}
