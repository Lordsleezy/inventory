// Depop manual sale form math. Profit = payout - cost; the payout field is pre-filled as sale price - Depop fee.
export type DepopEntry = {
  id: string; sku: string; item: string; sale_cents: number; fee_cents: number; payout_cents: number; sold_on: string;
  note: string | null; receipt_no: string | null; created_by_name: string | null; created_at: string;
  cost_cents: number | null; cost_missing: boolean; profit_cents: number | null;
};

/** Suggested payout in cents, or null while the sale price or fee is not a valid amount. Never below zero. */
export function payoutDefault(saleCents: number | null, feeCents: number | null): number | null {
  if (saleCents == null || feeCents == null) return null;
  return Math.max(0, saleCents - feeCents);
}

/** 2499 -> "24.99" (for money inputs). */
export function dollarsText(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Profit on a Depop sale; null while the unit has no cost (no default costs anywhere). */
export function depopProfit(payoutCents: number, costCents: number | null): number | null {
  return costCents == null ? null : payoutCents - costCents;
}
