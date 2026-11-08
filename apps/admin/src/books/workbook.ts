import { channelTitle } from './booksMath';
import { buildExpenses, filterReceived } from './expenseBuild';
import { loadCommissionOverrides } from './loadPayoutContext';
import { buildPayouts } from './payoutsBuild';
import { computeBooksFromReport } from './payoutTotals';
import { saleWhyText } from './saleNotes';
import type {
  BooksPayoutContext,
  BooksWorkbook,
  ExpenseDisplayLine,
  InventorySummary,
  MoneyActivityRow,
  MoneyOverviewRow,
  ReceivedItem,
  Report,
} from './types';
import type { CommissionOverride } from '../payouts';

export type WorkbookInput = {
  report: Report;
  inventory: InventorySummary;
  received: ReceivedItem[];
  payoutCtx: BooksPayoutContext;
  overrides: Map<string, CommissionOverride>;
  money: { overview: MoneyOverviewRow[]; activityByAccount: Record<string, MoneyActivityRow[]> };
  duplicateHidden: Set<string>;
  duplicateDecisions: Record<string, 'keep' | 'remove'>;
};

export function visibleExpenseRows(rows: ExpenseDisplayLine[], duplicateHidden: Set<string>, decisions: Record<string, 'keep' | 'remove'>) {
  return rows.filter((r) => {
    if (r.excludeFromTotals && duplicateHidden.has(r.id)) {
      return decisions[`${r.id}`] === 'keep';
    }
    if (r.excludeFromTotals && r.duplicateFlag) return false;
    return true;
  });
}

export function buildBooksWorkbook(input: WorkbookInput): BooksWorkbook {
  const { report, inventory, received, payoutCtx, overrides, money, duplicateHidden, duplicateDecisions } = input;
  const attributed = new Set(report.books_attributed_fee_ids || []);
  let built = buildExpenses(report, attributed);

  const visible = visibleExpenseRows(built.rows, duplicateHidden, duplicateDecisions);
  const counting = visible.filter((r) => !r.excludeFromTotals || duplicateDecisions[r.id] === 'keep');
  built = {
    ...built,
    rows: visible,
    total_cents: counting.reduce((n, e) => n + e.amount_cents, 0),
    reimburse_cents: counting.filter((r) => r.needs_reimbursement).reduce((n, r) => n + r.amount_cents, 0),
    otherExpenses_cents: counting.filter((r) => !r.countsInProfit).reduce((n, r) => n + r.amount_cents, 0),
    categoryTotals: [...counting.reduce((m, e) => m.set(e.category, (m.get(e.category) || 0) + e.amount_cents), new Map<string, number>())].map(([category, amount_cents]) => ({ category, amount_cents })),
    exportRows: built.exportRows,
  };

  const computed = computeBooksFromReport(report, payoutCtx, built.otherExpenses_cents, overrides);
  const salesLines = computed.salesLines.map((s) => ({
    ...s,
    channel: channelTitle(s.channel),
    profit_notes: saleWhyText({ id: s.sale_id, profit_cents: s.profit_cents }, report),
  }));

  const totals = computed.totals;
  const payouts = buildPayouts(report, totals, payoutCtx, money, overrides);

  const ch = new Map<string, { revenue_cents: number; profit_cents: number; count: number }>();
  for (const s of salesLines) {
    const key = s.channel;
    const item = ch.get(key) || { revenue_cents: 0, profit_cents: 0, count: 0 };
    item.revenue_cents += s.price_cents + s.buyer_shipping_cents;
    item.profit_cents += s.profit_cents ?? 0;
    item.count += s.qty;
    ch.set(key, item);
  }
  const channelTotals = [...ch.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([channel, v]) => ({ channel, ...v }));

  return {
    expenses: built,
    sales: { rows: salesLines, channelTotals, totals },
    payouts,
    inventory,
    received: filterReceived(received) as ReceivedItem[],
    proof: computed.proof,
    audit: computed.audit,
  };
}

export async function loadBooksMoney(client: import('@supabase/supabase-js').SupabaseClient) {
  const overviewRes = await client.rpc('portal_money_overview');
  if (overviewRes.error) throw overviewRes.error;
  const overview = ((overviewRes.data || []) as MoneyOverviewRow[]);
  const accounts = ['ebay', 'depop', 'mercari', 'square', 'tiktok', 'amazon', 'safe'];
  const activityByAccount: Record<string, MoneyActivityRow[]> = {};
  await Promise.all(accounts.map(async (acct) => {
    const { data, error } = await client.rpc('portal_money_activity', { p_account: acct, p_limit: 500, p_offset: 0 });
    if (error) return;
    activityByAccount[acct] = ((data as { rows: MoneyActivityRow[] })?.rows || []);
  }));
  return { overview, activityByAccount };
}

export function groupExpensesByCategory(rows: ExpenseDisplayLine[]) {
  const groups = new Map<string, ExpenseDisplayLine[]>();
  for (const e of rows) {
    if (e.children?.length) {
      const list = groups.get(e.category) || [];
      list.push(e);
      groups.set(e.category, list);
      continue;
    }
    const list = groups.get(e.category) || [];
    list.push(e);
    groups.set(e.category, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function receivedMonthStats(items: ReceivedItem[]) {
  let units = 0;
  let costCents = 0;
  for (const r of items) {
    const qty = Math.max(1, Number(r.qty_on_hand || 1));
    units += qty;
    costCents += Number(r.cost_cents || 0) * qty;
  }
  return { units, skus: items.length, cost_cents: costCents };
}

export function groupReceivedByDay(items: ReceivedItem[]) {
  const groups = new Map<string, ReceivedItem[]>();
  for (const r of items) {
    const day = String(r.received_at || '').slice(0, 10);
    const list = groups.get(day) || [];
    list.push(r);
    groups.set(day, list);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
}

export { loadCommissionOverrides };
