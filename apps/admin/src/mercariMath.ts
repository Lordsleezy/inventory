// Mercari manual sale form math.
// Fee default = 10% of (item price + buyer-paid shipping). Payout = item + ship − fee − label.
export type MercariEntry = {
  id: string; sku: string; item: string;
  sale_cents: number; buyer_shipping_cents: number; label_cost_cents: number;
  fee_cents: number; payout_cents: number; sold_on: string;
  note: string | null; receipt_no: string | null; created_by_name: string | null; created_at: string;
  cost_cents: number | null; cost_missing: boolean; profit_cents: number | null;
};

/** Mercari fee: 10% of item + buyer-paid shipping. Null while amounts are incomplete. */
export function mercariFeeDefault(saleCents: number | null, buyerShippingCents: number | null): number | null {
  if (saleCents == null || buyerShippingCents == null) return null;
  return Math.max(0, Math.round((saleCents + buyerShippingCents) * 0.1));
}

/** Suggested payout in cents. Never below zero. */
export function mercariPayoutDefault(
  saleCents: number | null,
  buyerShippingCents: number | null,
  feeCents: number | null,
  labelCents: number | null,
): number | null {
  if (saleCents == null || buyerShippingCents == null || feeCents == null || labelCents == null) return null;
  return Math.max(0, saleCents + buyerShippingCents - feeCents - labelCents);
}

/** 2499 -> "24.99" (for money inputs). */
export function dollarsText(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Profit on a Mercari sale; null while the unit has no cost. */
export function mercariProfit(payoutCents: number, costCents: number | null): number | null {
  return costCents == null ? null : payoutCents - costCents;
}
