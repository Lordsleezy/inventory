// Payout math, kept pure so it can be tested.
//
// Reports / owner "profit after costs":
//   item + buyer-paid shipping − channel fees − label/shipping cost − card processing − item cost
//
// Commission base (every percent-of-profit / online cut):
//   sale price (merchandise + buyer-paid shipping) − item cost
//   Tax and ALL fees stay out — commissions never shrink because of Square/eBay/label fees.
//
// `cost` arrives already resolved (real unit cost, collectible $0, or category default);
// `costEstimated` marks sales whose profit used a default instead of a real cost.
export type RuleMethod = 'percent_sale' | 'flat_ticket' | 'percent_profit';
export type Rule = { employee_id: string; method: RuleMethod; rate: number };
export type TicketLineLike = {
  sku: string;
  /** Merchandise cents for this line (pre-tax). */
  price_cents?: number | null;
  /** Resolved unit cost for this line. */
  cost_cents?: number | null;
  /** Legacy fee-adjusted ledger profit — ignored for commissions. */
  profit_cents?: number | null;
};
export type TicketLike = {
  subtotal: number; cost: number | null; channel: string; at?: string;
  feeCents?: number; shipCostCents?: number; processingFeeCents?: number;
  /** Buyer-paid shipping (revenue). Not the label we bought. */
  shippingCents?: number;
  // Back-compat aliases from the old eBay-only ledger.
  ebayFeeCents?: number; bakedShipCents?: number;
  costEstimated?: boolean;
  /** Prefer this when present — same cents as sale_ledger.profit_cents (fee-adjusted). */
  profitCents?: number | null;
  /** Sale lines — used for per-SKU in-store profit rate overrides. */
  lines?: TicketLineLike[];
};
export type OnlineCfg = { channels: string[]; pct: number; employeeId: string | null };
export const NO_ONLINE: OnlineCfg = { channels: [], pct: 0, employeeId: null };
export const isOnline = (t: TicketLike, cfg: OnlineCfg) => cfg.channels.includes((t.channel || '').toLowerCase());

/** Jacob / Paul UUIDs for one-off in-store SKU profit splits (global rules stay 10% / 20%). */
export const PAYOUT_JACOB_ID = 'c851c8ee-2cc2-490f-935f-1e2d7e093d88';
export const PAYOUT_PAUL_ID = 'f17e6163-b10a-4fe1-a373-75c0094e5363';
/** In-store percent-of-profit overrides: sku → employee_id → rate. */
export const IN_STORE_SKU_PROFIT_OVERRIDES: Record<string, Record<string, number>> = {
  '11314': { [PAYOUT_JACOB_ID]: 25, [PAYOUT_PAUL_ID]: 5 },
  '11386': { [PAYOUT_JACOB_ID]: 20, [PAYOUT_PAUL_ID]: 10 },
  '11415': { [PAYOUT_JACOB_ID]: 20, [PAYOUT_PAUL_ID]: 10 },
  '11522': { [PAYOUT_JACOB_ID]: 25, [PAYOUT_PAUL_ID]: 5 },
  // Dan Marjele signed jersey — Paul 30% of (sale − cost); Jacob none on this SKU.
  '99694': { [PAYOUT_JACOB_ID]: 0, [PAYOUT_PAUL_ID]: 30 },
  // Same ticket as 99694: Paul 10% / Jacob 20% of (sale − cost).
  '11629': { [PAYOUT_JACOB_ID]: 20, [PAYOUT_PAUL_ID]: 10 },
  '99695': { [PAYOUT_JACOB_ID]: 20, [PAYOUT_PAUL_ID]: 10 },
};

export function inStoreOverrideRate(sku: string, employeeId: string): number | undefined {
  return IN_STORE_SKU_PROFIT_OVERRIDES[sku]?.[employeeId];
}

const channelFees = (t: TicketLike) => Math.max(0, t.feeCents ?? t.ebayFeeCents ?? 0);
const shipCosts = (t: TicketLike) => Math.max(0, t.shipCostCents ?? t.bakedShipCents ?? 0);
const processing = (t: TicketLike) => Math.max(0, t.processingFeeCents ?? 0);
const buyerShipping = (t: TicketLike) => Math.max(0, t.shippingCents ?? 0);

/** Fee-adjusted profit (Reports). Null only when the ticket has no cost at all. */
export function profit(t: TicketLike): number | null {
  if (t.profitCents != null && Number.isFinite(t.profitCents)) return t.profitCents;
  if (t.cost === null) return null;
  return t.subtotal + buyerShipping(t) - channelFees(t) - shipCosts(t) - processing(t) - t.cost;
}

/** Commission base: sale (− tax/fees) minus cost. Buyer shipping counts as sale revenue. */
export function commissionProfit(t: TicketLike): number | null {
  if (t.cost === null) return null;
  return t.subtotal + buyerShipping(t) - t.cost;
}

/** Per-line commission base when price + cost are present. */
export function lineCommissionProfit(l: TicketLineLike): number | null {
  if (l.price_cents == null || !Number.isFinite(l.price_cents)) return null;
  if (l.cost_cents == null || !Number.isFinite(l.cost_cents)) return null;
  return l.price_cents - l.cost_cents;
}

/** Cents owed to this rule's person for one ticket. null = cannot be calculated (no cost anywhere). */
export function payout(t: TicketLike, rule: Rule | undefined, cfg: OnlineCfg): number | null {
  if (!rule) return null;
  if (isOnline(t, cfg)) {
    if (rule.employee_id !== cfg.employeeId) return 0;
    const p = commissionProfit(t);
    return p === null ? null : Math.round(Math.max(0, p) * cfg.pct / 100);
  }
  if (rule.method === 'flat_ticket') return Math.round(Number(rule.rate) * 100);
  if (rule.method === 'percent_profit') {
    const lines = t.lines || [];
    const touched = lines.some(l => inStoreOverrideRate(l.sku, rule.employee_id) != null);
    if (touched) {
      // Per-line rates so override SKUs can sit on a mixed ticket without changing other lines.
      const lineBases = lines.map(l => lineCommissionProfit(l));
      if (lineBases.some(b => b === null)) {
        const rates = lines.map(l => inStoreOverrideRate(l.sku, rule.employee_id) ?? Number(rule.rate));
        const p = commissionProfit(t);
        if (p === null) return null;
        if (rates.every(r => r === rates[0])) return Math.round(Math.max(0, p) * rates[0] / 100);
        return null;
      }
      return lines.reduce((n, l, i) => {
        const rate = inStoreOverrideRate(l.sku, rule.employee_id) ?? Number(rule.rate);
        return n + Math.round(Math.max(0, lineBases[i] || 0) * rate / 100);
      }, 0);
    }
    const p = commissionProfit(t);
    return p === null ? null : Math.round(Math.max(0, p) * Number(rule.rate) / 100);
  }
  return Math.round(t.subtotal * Number(rule.rate) / 100);
}

/** Owner share: fee-adjusted profit minus every commission cut. Null if unsettled. */
export function remainingProfit(t: TicketLike, rules: Rule[], cfg: OnlineCfg): number | null {
  const p = profit(t);
  if (p === null) return null;
  const cuts = rules.map(r => payout(t, r, cfg));
  if (cuts.some(x => x === null)) return null;
  const commissions = cuts.reduce<number>((n, x) => n + (x || 0), 0);
  // Commissions only take from non-negative commission base; owner share can still reflect a loss.
  return p - commissions;
}
