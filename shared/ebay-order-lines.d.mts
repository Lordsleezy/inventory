export type EbayLinePlan = {
  sku: string | null;
  paymentId: string;
  shipCents: number;
  feeCents: number;
  itemCents: number;
  orderId: string;
};

export function planEbayOrderLines(order: unknown, options?: Record<string, unknown>): {
  single: boolean;
  orderId: string;
  shipCents: number;
  plans: EbayLinePlan[];
};
export function ebayLineRepair(plans: EbayLinePlan[], existing: Array<Record<string, unknown>>): {
  inserts: EbayLinePlan[];
  shipping: Array<{ sku?: string; from_cents: number; shipping_cents: number }>;
};
export function refundScope(order: unknown): { scope: string; skus: string[] };
export function trackingUploads(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>>;
