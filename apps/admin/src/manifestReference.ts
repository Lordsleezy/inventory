export type ManifestReference = {
  received?: number; expected?: number; retail_cents: number; manifest_name: string; manifest_on: string;
  warnings: { manifest_name: string; total_qty: number; defective_qty: number; conditions: string[] }[];
};

export function manifestDefectWarnings(reference: ManifestReference): string[] {
  return reference.warnings.map(warning => warning.defective_qty < warning.total_qty
    ? `${warning.defective_qty} of ${warning.total_qty} units of this UPC on the manifest are marked ${warning.conditions.join(', ')}. Check this one.`
    : `Manifest warns an item with this UPC is defective (${warning.conditions.join(', ')}).`);
}
