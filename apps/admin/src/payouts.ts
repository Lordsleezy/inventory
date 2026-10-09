// Payout math, kept pure so it can be tested.
// Profit = sale price − channel fees − label/shipping cost − card processing fee − item cost.
// Tax, the customer card-fee surcharge, and buyer-paid shipping are pass-through: never profit.
// `cost` arrives already resolved (real unit cost, collectible $0, or category default);
// `costEstimated` marks sales whose profit used a default instead of a real cost.
export type RuleMethod = 'percent_sale' | 'flat_ticket' | 'percent_profit';
export type Rule = { employee_id: string; method: RuleMethod; rate: number };
export type TicketLike = {
  subtotal: number; cost: number | null; channel: string; at?: string;
  feeCents?: number; shipCostCents?: number; processingFeeCents?: number;
  // Back-compat aliases from the old eBay-only ledger.
  ebayFeeCents?: number; bakedShipCents?: number;
  costEstimated?: boolean;
};
export type OnlineCfg = { channels: string[]; pct: number; employeeId: string | null };
export const NO_ONLINE: OnlineCfg = { channels: [], pct: 0, employeeId: null };
export const isOnline = (t: TicketLike, cfg: OnlineCfg) => cfg.channels.includes((t.channel || '').toLowerCase());

const channelFees = (t: TicketLike) => Math.max(0, t.feeCents ?? t.ebayFeeCents ?? 0);
const shipCosts = (t: TicketLike) => Math.max(0, t.shipCostCents ?? t.bakedShipCents ?? 0);
const processing = (t: TicketLike) => Math.max(0, t.processingFeeCents ?? 0);

/** Real profit in cents; null only when the ticket has no cost at all (no default configured). */
export function profit(t: TicketLike): number | null {
  if (t.cost === null) return null;
  return t.subtotal - channelFees(t) - shipCosts(t) - processing(t) - t.cost;
}

/** Cents owed to this rule's person for one ticket. null = cannot be calculated (no cost anywhere). */
export function payout(t: TicketLike, rule: Rule | undefined, cfg: OnlineCfg): number | null {
  if (!rule) return null;
  if (isOnline(t, cfg)) {
    if (rule.employee_id !== cfg.employeeId) return 0;
    const p = profit(t);
    return p === null ? null : Math.round(Math.max(0, p) * cfg.pct / 100);
  }
  if (rule.method === 'flat_ticket') return Math.round(Number(rule.rate) * 100);
  if (rule.method === 'percent_profit') {
    const p = profit(t);
    return p === null ? null : Math.round(Math.max(0, p) * Number(rule.rate) / 100);
  }
  return Math.round(t.subtotal * Number(rule.rate) / 100);
}

/** Profit left after every payout cut; null if any cut is unsettled. */
export function remainingProfit(t: TicketLike, rules: Rule[], cfg: OnlineCfg): number | null {
  const p = profit(t);
  if (p === null) return null;
  const cuts = rules.map(r => payout(t, r, cfg));
  return cuts.some(x => x === null) ? null
    : p - cuts.reduce<number>((n, x) => n + (x || 0), 0);
}
