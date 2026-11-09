/** Listing title for UI — drops trailing " | SKU 12345" but does not change stored data. */
export function displayOrderTitle(title: string | null | undefined): string {
  const raw = (title || 'Item').trim();
  const stripped = raw.replace(/\s*\|\s*SKU\s*#?\d[\dA-Za-z-]*\s*$/i, '').trim();
  return stripped || raw || 'Item';
}

export const SEG_SHORT: Record<string, string> = {
  needsLabel: 'Needs label',
  toShip: 'To ship',
  packaged: 'Packaged',
  shipped: 'Shipped',
  delivered: 'Delivered',
  canceled: 'Canceled',
};
