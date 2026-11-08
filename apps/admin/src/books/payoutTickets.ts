import type { CommissionOverride, OnlineCfg, Rule, TicketLike, TicketLineLike } from '../payouts';
import { isOnline, payout, profit, remainingProfit } from '../payouts';
import { effectiveCostCents } from './costTruth';
import type { FrozenMap } from './types';
import type { Row } from './types';

export type MonthTicket = TicketLike & {
  key: string;
  at: string;
  saleIds: string[];
  commissionOverride?: CommissionOverride | null;
};

const IN_STORE = new Set(['floor', 'in_store', 'instore', 'store', 'website']);

function ticketKey(row: Row): string {
  return String(row.ticket_id || row.ticket_key || `sale:${row.id}`);
}

function lineFromSale(row: Row): TicketLineLike {
  const cost = effectiveCostCents(row);
  return {
    sku: String(row.sku || ''),
    price_cents: Number(row.price_cents || 0),
    cost_cents: cost,
    shipping_cents: Number(row.shipping_cents || 0),
    channel_fee_cents: Number(row.channel_fee_cents || 0),
    ship_cost_cents: Number(row.ship_cost_cents || 0),
    processing_fee_cents: Number(row.processing_fee_cents || 0),
    tax_owed_cents: Number(row.tax_owed_cents ?? row.tax_cents ?? 0),
  };
}

/** Group Books report sales into payout tickets (same logic as the payouts tab). */
export function ticketsFromReportSales(sales: Row[], overrides: Map<string, CommissionOverride> = new Map()): MonthTicket[] {
  const map = new Map<string, MonthTicket>();
  for (const l of sales) {
    const key = ticketKey(l);
    let t = map.get(key);
    if (!t) {
      const channel = String(l.channel || 'floor');
      t = {
        key,
        at: String(l.sold_at || l.date || ''),
        channel,
        subtotal: 0,
        cost: 0,
        feeCents: 0,
        shipCostCents: 0,
        processingFeeCents: 0,
        shippingCents: 0,
        ebayFeeCents: 0,
        bakedShipCents: 0,
        saleIds: [],
        lines: [],
        commissionOverride: overrides.get(key) || null,
      };
      map.set(key, t);
    }
    const line = lineFromSale(l);
    t.lines!.push(line);
    t.subtotal += line.price_cents || 0;
    t.feeCents = (t.feeCents || 0) + (line.channel_fee_cents || 0);
    t.shipCostCents = (t.shipCostCents || 0) + (line.ship_cost_cents || 0);
    t.processingFeeCents = (t.processingFeeCents || 0) + (line.processing_fee_cents || 0);
    t.shippingCents = (t.shippingCents || 0) + (line.shipping_cents || 0);
    const cost = effectiveCostCents(l);
    if (cost == null) t.cost = null;
    else if (t.cost !== null) t.cost += cost;
    t.saleIds.push(String(l.id));
  }
  return [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export function frozenTickets(frozen: FrozenMap | undefined): Set<string> {
  return new Set([...(frozen || new Map()).keys()].map((k) => k.slice(0, k.lastIndexOf('|'))));
}

export function cutCommission(
  key: string,
  ticket: TicketLike,
  rule: Rule,
  frozen: FrozenMap | undefined,
  cfg: OnlineCfg,
  frozenSet: Set<string>,
): number | null {
  if (ticket.cost === null) return null;
  if (!frozen || !frozenSet.has(key)) return payout(ticket, rule, cfg);
  const k = `${key}|${rule.employee_id}`;
  return frozen.has(k) ? frozen.get(k) ?? null : 0;
}

export function ticketCommissions(
  ticket: MonthTicket,
  rules: Rule[],
  frozen: FrozenMap | undefined,
  cfg: OnlineCfg,
): number | null {
  const frozenSet = frozenTickets(frozen);
  const amounts = rules.map((r) => cutCommission(ticket.key, ticket, r, frozen, cfg, frozenSet));
  if (amounts.some((x) => x === null)) return null;
  let sum = 0;
  for (const x of amounts) sum += x || 0;
  if (isOnline(ticket, cfg) && !ticket.commissionOverride) {
    sum = amounts.find((_, i) => rules[i].employee_id === cfg.employeeId) ?? 0;
    if (typeof sum !== 'number') sum = 0;
  }
  return sum;
}

export function ticketCommissionsAllRules(
  ticket: MonthTicket,
  rules: Rule[],
  frozen: FrozenMap | undefined,
  cfg: OnlineCfg,
): number | null {
  const frozenSet = frozenTickets(frozen);
  const cuts = rules.map((r) => cutCommission(ticket.key, ticket, r, frozen, cfg, frozenSet));
  if (cuts.some((x) => x === null)) return null;
  let sum = 0;
  for (const x of cuts) sum += x || 0;
  return sum;
}

export type SaleAuditFlag = { ticketKey: string; message: string };

export function auditInStoreFees(tickets: MonthTicket[]): SaleAuditFlag[] {
  const out: SaleAuditFlag[] = [];
  for (const t of tickets) {
    const ch = (t.channel || '').toLowerCase();
    if (!IN_STORE.has(ch)) continue;
    const fee = Math.max(0, t.feeCents ?? 0);
    if (fee > 0) {
      out.push({ ticketKey: t.key, message: `In-store sale ${t.key} has marketplace fee ${fee}¢ on the ledger — payouts tab may differ; not changed.` });
    }
  }
  return out;
}

function lineWeights(ticket: MonthTicket): number[] {
  const lines = ticket.lines || [];
  const weights = lines.map((l) => Math.max(0, Number(l.price_cents || 0)));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return lines.map(() => 1 / Math.max(1, lines.length));
  return weights.map((w) => w / sum);
}

export function ticketLineIndex(ticket: MonthTicket, row: Row): number {
  const lines = ticket.lines || [];
  const sku = String(row.sku || '');
  const price = Number(row.price_cents || 0);
  let idx = lines.findIndex((l) => l.sku === sku && Number(l.price_cents || 0) === price);
  if (idx >= 0) return idx;
  idx = lines.findIndex((l) => l.sku === sku);
  if (idx >= 0) return idx;
  const saleId = String(row.id ?? '');
  const pos = ticket.saleIds.indexOf(saleId);
  return pos >= 0 ? pos : 0;
}

export function sliceTicketLine(ticket: MonthTicket, lineIndex: number): MonthTicket {
  const lines = ticket.lines || [];
  const line = lines[lineIndex];
  if (!line) return ticket;
  const share = lineWeights(ticket)[lineIndex] ?? 1;
  const ch = (ticket.channel || '').toLowerCase();
  const inStore = IN_STORE.has(ch);
  return {
    ...ticket,
    subtotal: Number(line.price_cents || 0),
    cost: line.cost_cents == null ? null : Number(line.cost_cents),
    shippingCents: Math.max(0, Number(line.shipping_cents || 0)),
    feeCents: Math.round((ticket.feeCents || 0) * share),
    shipCostCents: Math.round((ticket.shipCostCents || 0) * share),
    processingFeeCents: inStore ? Math.max(0, Number(line.processing_fee_cents || 0)) : Math.round((ticket.processingFeeCents || 0) * share),
    lines: [line],
  };
}

/** Per-line store profit for Books export (in-store card fees are shown but net ~0 on profit). */
export function lineBooksProfit(ticket: MonthTicket, lineIndex: number): number | null {
  const slice = sliceTicketLine(ticket, lineIndex);
  const ch = (ticket.channel || '').toLowerCase();
  if (IN_STORE.has(ch)) {
    if (slice.cost === null) return null;
    return slice.subtotal + Math.max(0, slice.shippingCents || 0)
      - Math.max(0, slice.feeCents || 0) - Math.max(0, slice.shipCostCents || 0) - slice.cost;
  }
  return profit(slice);
}

export function ticketBooksProfit(ticket: MonthTicket): number | null {
  const lines = ticket.lines || [];
  if (!lines.length) return profit(ticket);
  let sum = 0;
  let any = false;
  for (let i = 0; i < lines.length; i++) {
    const p = lineBooksProfit(ticket, i);
    if (p === null) return null;
    sum += p;
    any = true;
  }
  return any ? sum : null;
}

export function lineBooksCommission(
  ticket: MonthTicket,
  lineIndex: number,
  rules: Rule[],
  frozen: FrozenMap | undefined,
  cfg: OnlineCfg,
): number | null {
  const slice = sliceTicketLine(ticket, lineIndex);
  if (slice.cost === null) return 0;
  return ticketCommissionsAllRules(slice as MonthTicket, rules, frozen, cfg) ?? 0;
}

export { profit, remainingProfit };
