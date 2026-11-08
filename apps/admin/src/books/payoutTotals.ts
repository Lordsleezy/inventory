import {
  commissionBreakdown,
  isOnline,
  type OnlineCfg,
  type Rule,
} from '../payouts';
import { channelTitle } from './booksMath';
import {
  auditInStoreFees,
  cutCommission,
  frozenTickets,
  profit,
  remainingProfit,
  ticketsFromReportSales,
  type MonthTicket,
} from './payoutTickets';
import type { BookTotals, BooksPayoutContext, FrozenMap, Report, Row, SalesLine } from './types';

const channelFees = (t: MonthTicket) => Math.max(0, t.feeCents ?? 0);
const shipCosts = (t: MonthTicket) => Math.max(0, t.shipCostCents ?? 0);
const processing = (t: MonthTicket) => Math.max(0, t.processingFeeCents ?? 0);
const buyerShipping = (t: MonthTicket) => Math.max(0, t.shippingCents ?? 0);

export type MonthProof = {
  revenue: number;
  cost: number;
  feesAndLabels: number;
  profit: number;
  commission: number;
  ownerBeforeOther: number;
  saleCount: number;
  pendingCost: number;
};

export function sumMonthFromPayoutTickets(
  tickets: MonthTicket[],
  rules: Rule[],
  cfg: OnlineCfg,
  frozen: FrozenMap,
  otherExpenses: number,
): { totals: BookTotals; proof: MonthProof; audit: ReturnType<typeof auditInStoreFees> } {
  let revenue = 0;
  let cost = 0;
  let feesAndLabels = 0;
  let labelCostsOnSales = 0;
  let profitSum = 0;
  let commissionSum = 0;
  let ownerSum = 0;
  let pendingCost = 0;
  const frozenSet = frozenTickets(frozen);

  for (const t of tickets) {
    revenue += t.subtotal + buyerShipping(t);
    if (t.cost === null) {
      pendingCost += 1;
      continue;
    }
    cost += t.cost;
    const mp = channelFees(t);
    const lbl = shipCosts(t);
    const proc = processing(t);
    feesAndLabels += mp + lbl + proc;
    labelCostsOnSales += lbl;
    const p = profit(t);
    if (p !== null) profitSum += p;
    const cuts = rules.map((r) => cutCommission(t.key, t, r, frozen, cfg, frozenSet));
    if (cuts.some((x) => x === null)) {
      pendingCost += 1;
      continue;
    }
    let comm = 0;
    for (const x of cuts) comm += x || 0;
    commissionSum += comm;
    const owner = remainingProfit(t, rules, cfg);
    if (owner !== null) ownerSum += owner;
  }

  const profitFinal = profitSum;
  const ownerKeeps = ownerSum - otherExpenses;

  const totals: BookTotals = {
    revenue,
    cost,
    fees: feesAndLabels,
    labelCostsOnSales,
    feesAndLabels,
    commission: commissionSum,
    profit: profitFinal,
    expense: otherExpenses,
    otherExpenses,
    ownerKeeps,
    shippingSurplus: 0,
    ledgerProfitGap: 0,
  };

  return {
    totals,
    proof: {
      revenue,
      cost,
      feesAndLabels,
      profit: profitFinal,
      commission: commissionSum,
      ownerBeforeOther: ownerSum,
      saleCount: tickets.length,
      pendingCost,
    },
    audit: auditInStoreFees(tickets),
  };
}

export function buildSalesLinesFromPayout(
  report: Report,
  tickets: MonthTicket[],
  rules: Rule[],
  cfg: OnlineCfg,
  frozen: FrozenMap,
): SalesLine[] {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const frozenSet = frozenTickets(frozen);
  const commPaid = new Set<string>();
  return (report.sales || []).map((row) => {
    const key = String(row.ticket_id || row.ticket_key || `sale:${row.id}`);
    const ticket = byKey.get(key);
    const ch = String(row.channel || '');
    const online = ticket ? isOnline(ticket, cfg) : isOnline({ channel: ch, subtotal: 0, cost: 0 }, cfg);
    const mp = online
      ? Math.max(0, Number(row.channel_fee_cents || 0))
      : 0;
    const label = Math.max(0, Number(row.ship_cost_cents || 0));
    const proc = Math.max(0, Number(row.processing_fee_cents || 0));
    let comm: number | null = null;
    if (ticket && !commPaid.has(key)) {
      const cuts = rules.map((r) => cutCommission(key, ticket, r, frozen, cfg, frozenSet));
      if (!cuts.some((x) => x === null)) {
        for (const x of cuts) comm = (comm || 0) + (x || 0);
        commPaid.add(key);
      }
    } else if (ticket && commPaid.has(key)) {
      comm = 0;
    }
    const p = ticket ? profit(ticket) : (row.cost_cents == null ? null : Number(row.profit_cents || 0));
    const notes = ticket ? commissionBreakdown(ticket, !!cfg.absorbFees).rows.map((r) => `${r.label} ${r.cents}`).join('; ') : '';
    return {
      sale_id: String(row.id ?? ''),
      date: String(row.sold_at || row.date || '').slice(0, 10),
      sku: String(row.sku || ''),
      title: String(row.item_title || row.title || row.sku || ''),
      channel: channelTitle(ch),
      order_no: String(row.receipt_no || row.order_id || ''),
      qty: Number(row.qty || 1),
      price_cents: Number(row.price_cents || 0),
      tax_cents: Number(row.tax_collected_cents ?? row.tax_cents ?? 0),
      marketplace_fees_cents: mp,
      card_fees_cents: proc,
      buyer_shipping_cents: Number(row.shipping_cents || 0),
      label_cost_cents: label,
      cost_cents: row.cost_cents == null ? null : Number(row.cost_cents),
      profit_cents: p,
      commission_cents: comm,
      profit_notes: notes,
    };
  });
}

export function computeBooksFromReport(
  report: Report,
  ctx: BooksPayoutContext,
  otherExpenses: number,
  overrides: Map<string, import('../payouts').CommissionOverride> = new Map(),
) {
  const tickets = ticketsFromReportSales(report.sales || [], overrides);
  const { totals, proof, audit } = sumMonthFromPayoutTickets(tickets, ctx.rules, ctx.cfg, ctx.frozen, otherExpenses);
  const salesLines = buildSalesLinesFromPayout(report, tickets, ctx.rules, ctx.cfg, ctx.frozen);
  return { totals, proof, audit, tickets, salesLines };
}

/** Cost treatment reference for the release report (matches payouts.ts). */
export const PAYOUT_COST_RULES_DOC = [
  { item: 'Marketplace fees', where: 'Online sales only', commission: 'Subtracted from commission base unless store absorbs fees', owner: 'Subtracted from store profit' },
  { item: 'Shipping labels', where: 'Online (not Mercari seller-paid)', commission: 'Subtracted from commission base', owner: 'Subtracted from store profit' },
  { item: 'Out-of-pocket labels (incl. Mercari)', where: 'On sale ship cost when tied to order', commission: 'Reduces commission base like other labels', owner: 'On store profit; reimburse on Expenses only (not Other expenses)' },
  { item: 'Buyer-paid shipping', where: 'Revenue', commission: 'Added to commission base', owner: 'Added to store profit' },
  { item: 'Promoted listing fees', where: 'On sale row channel fees', commission: 'Same as marketplace fees', owner: 'Same as marketplace fees' },
  { item: 'Underpaid postage', where: 'Added to sale label cost', commission: 'Reduces commission base', owner: 'Reduces store profit' },
  { item: 'Card processing', where: 'In-store card', commission: 'Net fee after customer surcharge (nets ~0)', owner: 'Net fee after surcharge' },
  { item: 'Sales tax', where: 'Pass-through', commission: 'Not in commission base', owner: 'Not in store profit' },
  { item: 'Return costs', where: 'Adjustments ledger', commission: 'Via payout adjustments', owner: 'Via adjustments' },
  { item: 'Supplies / bonus', where: 'Expenses page', commission: 'Bonus not in Books commission total', owner: 'Other expenses → owner only' },
] as const;
