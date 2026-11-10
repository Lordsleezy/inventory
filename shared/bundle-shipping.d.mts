export const USPS_GA_MAX_LB: number;
export const USPS_GA_MAX_LENGTH_IN: number;
export const USPS_GA_MAX_LENGTH_PLUS_GIRTH: number;
export const DEFAULT_RATES: BundleRate[];
export const BUYER_REFUND_NOTE: string;

export type BundleRate = { max_lb: number; size_class: string; price_cents: number };

export type BundleItem = {
  id: string;
  sku?: string | null;
  title?: string | null;
  channel?: string | null;
  buyer_name?: string | null;
  buyer_email?: string | null;
  ship_line1?: string | null;
  ship_line2?: string | null;
  ship_city?: string | null;
  ship_region?: string | null;
  ship_postal?: string | null;
  shipping_cents?: number | null;
  item_cents?: number | null;
  weight_lb?: number | null;
  length_in?: number | null;
  width_in?: number | null;
  height_in?: number | null;
  paid_at?: string | null;
  status?: string | null;
  shipped_at?: string | null;
  canceled_at?: string | null;
  delivered_at?: string | null;
  fulfillment?: string | null;
  order_no?: string | null;
  label_cost_cents?: number | null;
};

export type BundleQuote = {
  ok: boolean;
  reason: string;
  price_cents: number;
  separate_cents: number;
  max_single_cents?: number;
  tier_cents?: number | null;
  size_class?: string;
  flag: boolean;
  package?: { length_in: number; width_in: number; height_in: number; weight_lb: number };
  length_in?: number;
  girth_in?: number;
};

export type BundleMoney = {
  action: string;
  bundle_cents: number;
  separate_cents: number;
  refund_cents: number;
  invoice_cents: number;
  allocations: Record<string, number>;
  refunds: { id: string; order_no: string | null; refund_cents: number }[];
};

export type BundleGroup = {
  id: string;
  channel: string;
  buyer: string;
  items: BundleItem[];
  quote: BundleQuote;
  money: BundleMoney;
};

export function packageVolume(item: BundleItem): number;
export function longestSide(item: BundleItem): number;
export function biggestPackage(items: BundleItem[]): BundleItem | null;
export function sizeClass(longest: number): string;
export function lookupRateCents(weightLb: number, size: string, rates?: BundleRate[]): number | null;
export function sumShipping(items: BundleItem[]): number;
export function quoteBundle(items: BundleItem[], rates?: BundleRate[]): BundleQuote;
export function allocateBundleShipping(items: BundleItem[], bundleCents: number): Record<string, number>;
export function allocateByWeight(items: BundleItem[], totalCents: number): Record<string, number>;
export function bundleMoneyPlan(items: BundleItem[], quote: BundleQuote): BundleMoney;
export function buyerKey(order: BundleItem): string;
export function addressKey(order: BundleItem): string;
export function groupOpenOrders(orders: BundleItem[], opts?: {
  splitIds?: string[];
  links?: { order_id: string; peer_id: string }[];
  rates?: BundleRate[];
}): BundleGroup[];
export function assertBundleConfirm(confirm: boolean): void;
export function dollars(centsValue: number): string;
export function issueRefundBody(refundCents: number, comment?: string): {
  reasonForRefund: string;
  comment: string;
  orderLevelRefundAmount: { currency: string; value: string };
};
export function addOrderInnerXml(input: {
  lineItems: { legacyItemId?: string; itemId?: string; transactionId?: string }[];
  shippingCents: number;
  itemCents?: number;
  shippingService?: string;
}): string;
export function sendInvoiceInnerXml(orderId: string): string;
export function calculatedCombinedWeightBody(existingDuration?: string): {
  calculatedShippingRule: { combinedShippingRuleType: string };
  combinedDuration: string;
};
export function combinedWeightDecision(policy: { shippingOptions?: { costType?: string }[] } | null, rules: {
  calculatedShippingRule?: { combinedShippingRuleType?: string };
  combinedDuration?: string;
} | null): { write: boolean; reason: string; body?: { calculatedShippingRule: { combinedShippingRuleType: string }; combinedDuration: string } };
