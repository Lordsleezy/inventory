import { replacementAddback } from '../dispositions';
import {
  isBonusCategory,
  isOnline,
  payout,
  payoutCardIncludesSale,
  reimbursementStillOwed,
  type CommissionOverride,
  type OnlineCfg,
  type Rule,
  type TicketLike,
} from '../payouts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAllPortalExpenses } from '../payoutExpenses';
import { mergeEmployeeIds } from './personMerge';
import type { FrozenMap } from './types';

export const BOOKS_WORKBOOK_VERSION = 2;

export type PayoutLine = Record<string, unknown> & {
  ticket_key: string;
  sold_at: string;
  sku: string;
  price_cents: number;
  cost_cents: number | null;
  channel: string;
  channel_fee_cents?: number | null;
  ship_cost_cents?: number | null;
  processing_fee_cents?: number | null;
  shipping_cents?: number | null;
  tax_cents?: number;
  tax_owed_cents?: number | null;
  payment_method?: string;
};

function parseShipCostSource(_v: unknown) {
  return { pendingCreditCents: 0 };
}

export function linesToPayoutTickets(lines: PayoutLine[], overrides: Map<string, CommissionOverride> = new Map()): PayoutSaleTicket[] {
  const map = new Map<string, PayoutSaleTicket>();
  for (const l of lines) {
    let t = map.get(l.ticket_key);
    if (!t) {
      t = {
        key: l.ticket_key,
        at: String(l.sold_at),
        lines: [],
        subtotal: 0,
        cost: 0,
        channel: String(l.channel || ''),
        feeCents: 0,
        shipCostCents: 0,
        processingFeeCents: 0,
        shippingCents: 0,
        commissionOverride: overrides.get(l.ticket_key) || null,
      };
      map.set(l.ticket_key, t);
    }
    t.lines.push({
      sku: String(l.sku || ''),
      price_cents: Number(l.price_cents || 0),
      cost_cents: l.cost_cents == null ? null : Number(l.cost_cents),
      shipping_cents: Number(l.shipping_cents || 0),
      channel_fee_cents: Number(l.channel_fee_cents || 0),
      ship_cost_cents: Number(l.ship_cost_cents || 0),
      processing_fee_cents: Number(l.processing_fee_cents || 0),
      tax_owed_cents: Number(l.tax_owed_cents ?? l.tax_cents ?? 0),
    });
    t.subtotal += Number(l.price_cents || 0);
    t.feeCents = (t.feeCents || 0) + Number(l.channel_fee_cents || 0);
    t.shipCostCents = (t.shipCostCents || 0) + Number(l.ship_cost_cents || 0);
    t.processingFeeCents = (t.processingFeeCents || 0) + Number(l.processing_fee_cents || 0);
    t.shippingCents = (t.shippingCents || 0) + Number(l.shipping_cents || 0);
    if (l.cost_cents == null) t.cost = null;
    else if (t.cost !== null) t.cost += Number(l.cost_cents);
  }
  return [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export async function loadPayoutLedgerData(client: SupabaseClient, storeId: string, overrides: Map<string, CommissionOverride>) {
  const lines: PayoutLine[] = [];
  for (let offset = 0;; offset += 1000) {
    const res = await client.rpc('portal_payout_sales').range(offset, offset + 999);
    if (res.error) throw res.error;
    const batch = (res.data || []) as PayoutLine[];
    lines.push(...batch);
    if (batch.length < 1000) break;
  }
  const payments: LedgerPayment[] = [];
  for (let offset = 0;; offset += 1000) {
    const res = await client.from('portal_payout_payments')
      .select('id,employee_id,amount_cents,paid_at,paid_by,legacy_ticket_key,note,voided_at')
      .eq('store_id', storeId).is('voided_at', null).order('paid_at', { ascending: false })
      .range(offset, offset + 999);
    if (res.error) throw res.error;
    payments.push(...((res.data || []) as LedgerPayment[]));
    if ((res.data || []).length < 1000) break;
  }
  let adjustments: LedgerAdjustment[] = [];
  const adjRes = await client.rpc('portal_payout_adjustments');
  if (!adjRes.error) adjustments = (adjRes.data || []) as LedgerAdjustment[];
  const expenses = await loadAllPortalExpenses<LedgerExpense>(client, storeId);
  const allSales = linesToPayoutTickets(lines, overrides);
  return { allSales, payments, adjustments, expenses };
}

export type LedgerPayment = {
  id?: string;
  employee_id: string;
  amount_cents: number;
  paid_at: string;
  note?: string | null;
  paid_by?: string;
  legacy_ticket_key?: string | null;
  voided_at?: string | null;
};

export type LedgerAdjustment = {
  employee_id: string;
  amount_cents: number;
  created_at: string;
  return_id?: string | null;
  sale_id?: number | null;
  ticket_key?: string | null;
  reason?: string;
  sale_commission_cents?: number | null;
  replacement_id?: string | null;
  fee_rule_change?: boolean | null;
};

export type LedgerExpense = {
  voided_at?: string | null;
  employee_id?: string | null;
  category?: string;
  amount_cents: number;
  needs_reimbursement?: boolean;
  description?: string;
  spent_on?: string;
};

export type PayoutSaleTicket = TicketLike & {
  key: string;
  at: string;
  lines: {
    sku: string;
    price_cents?: number | null;
    cost_cents?: number | null;
    shipping_cents?: number | null;
    channel_fee_cents?: number | null;
    ship_cost_cents?: number | null;
    processing_fee_cents?: number | null;
    tax_owed_cents?: number | null;
  }[];
  commissionOverride?: CommissionOverride | null;
};

export type PersonBalance = {
  user_id: string;
  balance: number;
  commissionOwed: number;
  reimburseOwed: number;
};

function frozenTickets(frozen: FrozenMap | undefined): Set<string> {
  return new Set([...(frozen || new Map()).keys()].map((k) => k.slice(0, k.lastIndexOf('|'))));
}

function cutCommission(
  key: string,
  ticket: TicketLike,
  rule: Rule,
  frozen: FrozenMap | undefined,
  cfg: OnlineCfg,
  frozenSet: Set<string>,
): number | null {
  if (!frozen || !frozenSet.has(key)) return payout(ticket, rule, cfg);
  const k = `${key}|${rule.employee_id}`;
  return frozen.has(k) ? frozen.get(k) ?? null : 0;
}

/** Same balance math as the Payouts tab person cards (commission + reimburse − payments). */
export function computePayoutPersonBalances(input: {
  staff: { user_id: string; display_name: string; email?: string | null }[];
  peopleSlots: { slot: string; employee_id: string | null }[];
  rules: Rule[];
  cfg: OnlineCfg;
  frozen: FrozenMap;
  allSales: PayoutSaleTicket[];
  payments: LedgerPayment[];
  adjustments: LedgerAdjustment[];
  expenses: LedgerExpense[];
}): PersonBalance[] {
  const { staff, peopleSlots, rules, cfg, frozen, allSales, payments, adjustments, expenses } = input;
  const frozenSet = frozenTickets(frozen);
  const { paulId, jacobId } = mergeEmployeeIds(staff, peopleSlots);
  const staffIds = new Set(staff.map((s) => s.user_id));
  if (paulId) staffIds.add(paulId);
  if (jacobId) staffIds.add(jacobId);

  const hasReimburse = (id: string) => expenses.some((e) => !e.voided_at && e.employee_id === id && (e.needs_reimbursement || isBonusCategory(String(e.category || ''))));
  const hasAdjustment = (id: string) => adjustments.some((a) => a.employee_id === id);
  const active = staff.filter((p) => rules.some((r) => r.employee_id === p.user_id) || hasReimburse(p.user_id) || hasAdjustment(p.user_id));

  return active.map((person) => {
    const rule = rules.find((r) => r.employee_id === person.user_id);
    let commission = 0;
    let reimburse = 0;
    let adjTotal = 0;
    let addbackTotal = 0;

    if (rule) {
      for (const t of allSales) {
        const online = isOnline(t, cfg);
        const ticket = { ...t, commissionOverride: t.commissionOverride ?? null };
        const amount = cutCommission(t.key, ticket, rule, frozen, cfg, frozenSet);
        if (!payoutCardIncludesSale(amount)) continue;
        if (online && !t.commissionOverride && person.user_id !== cfg.employeeId) continue;
        if (online && t.commissionOverride && person.user_id !== cfg.employeeId) {
          const rate = person.user_id === cfg.slots?.paul ? t.commissionOverride.paulPct
            : person.user_id === cfg.slots?.jacob ? t.commissionOverride.jacobPct
            : 0;
          if (!rate) continue;
        }
        commission += amount || 0;
      }
    }

    const personAdjs = adjustments.filter((a) => a.employee_id === person.user_id);
    adjTotal = personAdjs.reduce((n, a) => n + a.amount_cents, 0);
    addbackTotal = personAdjs
      .filter((a) => {
        if (a.amount_cents < 0 && a.return_id && (a.sale_commission_cents || 0) > 0) return true;
        return replacementAddback(a) !== 0;
      })
      .reduce((n, a) => {
        if (a.amount_cents < 0 && a.return_id && (a.sale_commission_cents || 0) > 0) return n + (a.sale_commission_cents || 0);
        return n + replacementAddback(a);
      }, 0);

    const bonus = expenses
      .filter((e) => !e.voided_at && e.employee_id === person.user_id && isBonusCategory(String(e.category || '')))
      .reduce((n, e) => n + e.amount_cents, 0);
    commission += bonus;

    const reimburseEntries = expenses
      .filter((e) => !e.voided_at && e.employee_id === person.user_id && e.needs_reimbursement && !isBonusCategory(String(e.category || '')))
      .map((e) => ({ at: `${e.spent_on}T12:00:00`, amount: e.amount_cents }));
    reimburse = reimburseEntries.reduce((n, e) => n + e.amount, 0);

    const personPays = payments.filter((p) => p.employee_id === person.user_id && !p.voided_at);
    const paidTotal = personPays.reduce((n, p) => n + p.amount_cents, 0);
    const balance = commission + addbackTotal + adjTotal + reimburse - paidTotal;

    const unpaidReimburse = reimbursementStillOwed(
      reimburseEntries,
      personPays.map((p) => ({ at: p.paid_at, amount: p.amount_cents, note: p.note })),
    );
    const reimburseOwed = Math.min(unpaidReimburse, Math.max(0, balance));
    const commissionOwed = balance - reimburseOwed;

    if (!staffIds.has(person.user_id) && person.user_id !== paulId && person.user_id !== jacobId) {
      return { user_id: person.user_id, balance: 0, commissionOwed: 0, reimburseOwed: 0 };
    }

    return { user_id: person.user_id, balance, commissionOwed, reimburseOwed };
  });
}

export function paulJacobOwed(balances: PersonBalance[], paulIds: string[], jacobIds: string[]): { paul: number; jacob: number } {
  const sum = (ids: string[]) => ids.reduce((n, id) => n + (balances.find((b) => b.user_id === id)?.balance || 0), 0);
  return { paul: sum(paulIds), jacob: sum(jacobIds) };
}
