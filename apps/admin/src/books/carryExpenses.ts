import type { SupabaseClient } from '@supabase/supabase-js';
import { isBonusCategory, paymentAppliesToCommission, payoutDay } from '../payouts.ts';
import type { Report, Row } from './types';

type CarryExpense = { id: string; at: string; amount: number; employee_id: string };
type CarryPayment = { at: string; amount: number; employee_id: string; note?: string | null };

/**
 * Net loss from earlier months that later profit has not covered.
 * Nets are that month alone, oldest first. A profit month pays the loss down.
 * A surplus does not become a credit in the next month.
 * The result is positive cents still unpaid.
 */
export function carriedLossCents(earlierNets: number[]): number {
  let running = 0;
  for (const net of earlierNets) {
    running += Number(net) || 0;
    if (running > 0) running = 0;
  }
  return running < 0 ? -running : 0;
}

export function workbookWithCarriedLoss<T extends { expenses: { carried_loss_cents?: number } }>(
  workbook: T,
  earlierNets: number[],
): T {
  const loss = carriedLossCents(earlierNets);
  if (!loss) return workbook;
  return { ...workbook, expenses: { ...workbook.expenses, carried_loss_cents: loss } };
}

/**
 * Reimbursements from before this period that payments through the period end have not covered.
 * A commission-tagged payment does not pay a reimbursement. Oldest expenses are paid first.
 */
export function unpaidCarryCents(
  expenses: CarryExpense[],
  payments: CarryPayment[],
  periodStart: string,
  periodEnd: string,
): Map<string, number> {
  const owed = new Map<string, number>();
  const people = new Set<string>();
  for (const row of expenses) {
    if (payoutDay(row.at) < periodStart) people.add(row.employee_id || '');
  }
  for (const person of people) {
    const open: { id: string; day: string; left: number }[] = [];
    const events: { day: string; kind: number; id: string; amount: number; commissionOnly: boolean }[] = [];
    for (const row of expenses) {
      if ((row.employee_id || '') !== person) continue;
      const day = payoutDay(row.at);
      if (!day || day >= periodStart || row.amount <= 0) continue;
      events.push({ day, kind: 0, id: row.id, amount: row.amount, commissionOnly: false });
    }
    for (const row of payments) {
      if ((row.employee_id || '') !== person) continue;
      const day = payoutDay(row.at);
      if (!day || day > periodEnd || row.amount <= 0) continue;
      events.push({
        day,
        kind: 1,
        id: '',
        amount: row.amount,
        commissionOnly: paymentAppliesToCommission(row.note),
      });
    }
    events.sort((a, b) => a.day.localeCompare(b.day) || a.kind - b.kind);
    for (const event of events) {
      if (event.kind === 0) {
        open.push({ id: event.id, day: event.day, left: event.amount });
        continue;
      }
      if (event.commissionOnly) continue;
      let left = event.amount;
      for (const row of open) {
        if (left <= 0) break;
        const take = Math.min(left, row.left);
        row.left -= take;
        left -= take;
      }
    }
    for (const row of open) {
      if (row.left > 0) owed.set(row.id, row.left);
    }
  }
  return owed;
}

async function eachPage<T>(load: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await load(offset, offset + 999);
    if (res.error) throw new Error(res.error.message);
    const batch = res.data || [];
    rows.push(...batch);
    if (batch.length < 1000) return rows;
  }
}

/** Prior reimbursements still unpaid at the end of this period, shaped like report expense rows. */
export async function loadUnpaidCarryExpenses(
  client: SupabaseClient,
  storeId: string,
  periodStart: string,
  periodEnd: string,
): Promise<Row[]> {
  if (!storeId || !periodStart || !periodEnd) return [];
  const [expenses, payments] = await Promise.all([
    eachPage<Row>((from, to) => client
      .from('portal_expenses')
      .select('id,spent_on,description,category,amount_cents,needs_reimbursement,source,order_id,label_id,external_id,employee_id,sku,sale_id')
      .eq('store_id', storeId)
      .eq('needs_reimbursement', true)
      .is('voided_at', null)
      .lt('spent_on', periodStart)
      .order('spent_on', { ascending: true })
      .range(from, to)),
    eachPage<Row>((from, to) => client
      .from('portal_payout_payments')
      .select('employee_id,amount_cents,paid_at,note,voided_at')
      .eq('store_id', storeId)
      .is('voided_at', null)
      .order('paid_at', { ascending: true })
      .range(from, to)),
  ]);
  const openExpenses = expenses.filter((row) => !isBonusCategory(String(row.category || '')));
  const owed = unpaidCarryCents(
    openExpenses.map((row) => ({
      id: String(row.id),
      at: String(row.spent_on || ''),
      amount: Number(row.amount_cents || 0),
      employee_id: String(row.employee_id || ''),
    })),
    payments.map((row) => ({
      at: String(row.paid_at || ''),
      amount: Number(row.amount_cents || 0),
      employee_id: String(row.employee_id || ''),
      note: row.note == null ? null : String(row.note),
    })),
    periodStart,
    periodEnd,
  );
  return openExpenses.flatMap((row) => {
    const unpaid = owed.get(String(row.id)) || 0;
    if (unpaid <= 0) return [];
    return [{ ...row, amount_cents: unpaid, date: row.spent_on, carried_forward: true }];
  });
}

/** Earlier bonus expenses for people who gave part of a bonus away during this period. */
export async function loadPriorBonusExpenses(
  client: SupabaseClient,
  storeId: string,
  periodStart: string,
  adjustments: Row[],
): Promise<Row[]> {
  const split = (adjustments || []).some((row) => /bonus/i.test(String(row.reason || '')) && Number(row.amount_cents) < 0);
  if (!storeId || !periodStart || !split) return [];
  return eachPage<Row>((from, to) => client
    .from('portal_expenses')
    .select('id,spent_on,description,category,amount_cents,employee_id,voided_at')
    .eq('store_id', storeId)
    .is('voided_at', null)
    .lt('spent_on', periodStart)
    .or('category.ilike.bonus,description.ilike.*bonus*')
    .order('spent_on', { ascending: true })
    .range(from, to));
}

export function attachPriorBonuses<T extends Report>(report: T, rows: Row[]): T {
  if (!rows.length) return report;
  return { ...report, prior_bonuses: rows };
}

export function attachCarryExpenses<T extends Report>(report: T, rows: Row[]): T {
  if (!rows.length) return report;
  const have = new Set((report.expenses || []).map((row) => String(row.id)));
  const extra = rows.filter((row) => row.id == null || !have.has(String(row.id)));
  if (!extra.length) return report;
  return { ...report, expenses: [...(report.expenses || []), ...extra] };
}
