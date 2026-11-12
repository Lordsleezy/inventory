/** Parse a dollar amount like 12.50 into cents. Empty → null. */
export function parseLotCostCents(raw: string): number | null {
  const text = String(raw || '').trim().replace(/^\$/, '');
  if (!text) return null;
  if (!/^\d+(?:\.\d{0,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  if (!Number.isFinite(cents) || cents < 0) return null;
  return cents;
}

/** Total lot $ ÷ item_count → per-unit acquisition cost (cents). */
export function manifestUnitCostCents(totalCents: number, itemCount: number): number | null {
  if (!Number.isFinite(totalCents) || totalCents < 0) return null;
  if (!Number.isInteger(itemCount) || itemCount <= 0) return null;
  return Math.round(totalCents / itemCount);
}

export function formatCentsAsDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
