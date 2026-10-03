// Payout math, kept pure so it can be tested. In-store rules are unchanged from before the online rule existed.
export type Rule = { employee_id: string; method: 'percent_sale' | 'flat_ticket' | 'percent_profit'; rate: number };
export type TicketLike = { subtotal: number; cost: number | null; channel: string };
// Online sales (website now; eBay etc. by adding the channel) pay the owner a share of PROFIT and nobody else.
// Profit = sale price - acquisition cost; tax, card fee, shipping and label cost are all outside the sale price.
export type OnlineCfg = { channels: string[]; pct: number; employeeId: string | null };
export const NO_ONLINE: OnlineCfg = { channels: [], pct: 0, employeeId: null };
export const isOnline = (t: TicketLike, cfg: OnlineCfg) => cfg.channels.includes((t.channel || '').toLowerCase());

/** Cents owed to this rule's person for one ticket; null = cannot be calculated yet (cost missing). */
export function payout(t: TicketLike, rule: Rule | undefined, cfg: OnlineCfg): number | null {
  if (!rule) return null;
  if (isOnline(t, cfg)) {
    if (rule.employee_id !== cfg.employeeId) return 0;
    if (t.cost === null) return null;
    return Math.round(Math.max(0, t.subtotal - t.cost) * cfg.pct / 100);
  }
  if (rule.method === 'flat_ticket') return Math.round(Number(rule.rate) * 100);
  if (rule.method === 'percent_profit' && t.cost === null) return null;
  const basis = rule.method === 'percent_profit' ? Math.max(0, t.subtotal - (t.cost || 0)) : t.subtotal;
  return Math.round(basis * Number(rule.rate) / 100);
}

export function remainingProfit(t: TicketLike, rules: Rule[], cfg: OnlineCfg): number | null {
  const cuts = rules.map(r => payout(t, r, cfg));
  return cuts.some(x => x === null) ? null
    : t.subtotal - cuts.reduce<number>((n, x) => n + (x || 0), 0);
}
