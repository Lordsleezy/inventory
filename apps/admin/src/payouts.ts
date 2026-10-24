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
/** Per-sale Paul/Jacob percent-of-(sale−cost) override. Null/absent = use defaults. */
export type CommissionOverride = { paulPct: number; jacobPct: number };
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
  /** Admin per-sale commission split override (Paul / Jacob). */
  commissionOverride?: CommissionOverride | null;
};
export type OnlineCfg = {
  channels: string[]; pct: number; employeeId: string | null;
  /** Who fills the Paul / Jacob per-sale override columns (store_payout_people). */
  slots?: { paul?: string | null; jacob?: string | null };
  /** sku → employee_id → in-store percent-of-profit rate (store_payout_sku_rates). */
  skuRates?: Record<string, Record<string, number>>;
};
export const NO_ONLINE: OnlineCfg = { channels: [], pct: 0, employeeId: null };
export const isOnline = (t: TicketLike, cfg: OnlineCfg) => cfg.channels.includes((t.channel || '').toLowerCase());

/** In-store percent-of-profit rate for one SKU and person (store_payout_sku_rates). */
export function inStoreOverrideRate(sku: string, employeeId: string, cfg: OnlineCfg): number | undefined {
  return cfg.skuRates?.[sku]?.[employeeId];
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

/**
 * Reports → Profit (all time) is the sum of sale profit minus eBay insertion and
 * store-subscription fees. Those fees are not on a sale row. Commissions stay on
 * sale − cost and are not reduced here. Losses are kept.
 */
export function reportProfitCents(saleProfitCents: number | null, ebayOverheadCents: number): number | null {
  if (saleProfitCents == null || !Number.isFinite(saleProfitCents)) return null;
  const overhead = Number.isFinite(ebayOverheadCents) ? Math.max(0, Math.round(ebayOverheadCents)) : 0;
  return saleProfitCents - overhead;
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

/**
 * Channel defaults for Paul/Jacob when no per-sale override is set.
 * Online → online pct / 0. In-store → rule rates (SKU line overrides ignored here).
 */
export function defaultCommissionSplit(t: TicketLike, rules: Rule[], cfg: OnlineCfg): CommissionOverride {
  if (isOnline(t, cfg)) {
    return { paulPct: Number(cfg.pct) || 0, jacobPct: 0 };
  }
  const paul = rules.find(r => r.employee_id === cfg.slots?.paul);
  const jacob = rules.find(r => r.employee_id === cfg.slots?.jacob);
  return {
    paulPct: paul && paul.method === 'percent_profit' ? Number(paul.rate) || 0 : Number(paul?.rate) || 0,
    jacobPct: jacob && jacob.method === 'percent_profit' ? Number(jacob.rate) || 0 : Number(jacob?.rate) || 0,
  };
}

/** Effective Paul/Jacob % for display (override wins). */
export function effectiveCommissionSplit(
  t: TicketLike, rules: Rule[], cfg: OnlineCfg,
): CommissionOverride & { overridden: boolean } {
  if (t.commissionOverride) {
    return { ...t.commissionOverride, overridden: true };
  }
  return { ...defaultCommissionSplit(t, rules, cfg), overridden: false };
}

function overridePayout(t: TicketLike, employeeId: string, ov: CommissionOverride, cfg: OnlineCfg): number | null {
  const p = commissionProfit(t);
  if (p === null) return null;
  const rate = cfg.slots?.paul && employeeId === cfg.slots.paul ? ov.paulPct
    : cfg.slots?.jacob && employeeId === cfg.slots.jacob ? ov.jacobPct
    : 0;
  return Math.round(Math.max(0, p) * Number(rate) / 100);
}

/** Cents owed to this rule's person for one ticket. null = cannot be calculated (no cost anywhere). */
export function payout(t: TicketLike, rule: Rule | undefined, cfg: OnlineCfg): number | null {
  if (!rule) return null;
  if (t.commissionOverride) {
    return overridePayout(t, rule.employee_id, t.commissionOverride, cfg);
  }
  if (isOnline(t, cfg)) {
    if (rule.employee_id !== cfg.employeeId) return 0;
    const p = commissionProfit(t);
    return p === null ? null : Math.round(Math.max(0, p) * cfg.pct / 100);
  }
  if (rule.method === 'flat_ticket') return Math.round(Number(rule.rate) * 100);
  if (rule.method === 'percent_profit') {
    const lines = t.lines || [];
    const touched = lines.some(l => inStoreOverrideRate(l.sku, rule.employee_id, cfg) != null);
    if (touched) {
      // Per-line rates so override SKUs can sit on a mixed ticket without changing other lines.
      const lineBases = lines.map(l => lineCommissionProfit(l));
      if (lineBases.some(b => b === null)) {
        const rates = lines.map(l => inStoreOverrideRate(l.sku, rule.employee_id, cfg) ?? Number(rule.rate));
        const p = commissionProfit(t);
        if (p === null) return null;
        if (rates.every(r => r === rates[0])) return Math.round(Math.max(0, p) * rates[0] / 100);
        return null;
      }
      return lines.reduce((n, l, i) => {
        const rate = inStoreOverrideRate(l.sku, rule.employee_id, cfg) ?? Number(rule.rate);
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
