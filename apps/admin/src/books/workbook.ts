import { channelTitle } from './booksMath';
import { buildExpenses, filterReceived } from './expenseBuild';
import { loadCommissionOverrides } from './loadPayoutContext';
import { buildPayouts } from './payoutsBuild';
import { verifyBooksIntegrity, ledgerOwedFromBalances } from './booksProof';
import { verifyExportTies } from './exportChecks';
import { computeBooksFromReport } from './payoutTotals';
import type { PersonBalance } from './payoutLedger';
import { listFlaggedDefaultCostSales, listTrulyMissingCostSales } from './costTruth';
import { saleWhyText } from './saleNotes';
import { manifestedItemCount } from './receivedSummary';
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
  money: { overview: MoneyOverviewRow[]; activityByAccount: Record<string, MoneyActivityRow[]>; snapshots?: { start?: { account: string; balance_cents: number }[]; end?: { account: string; balance_cents: number }[] } };
  duplicateHidden: Set<string>;
  duplicateDecisions: Record<string, 'keep' | 'remove'>;
  ledgerBalances?: PersonBalance[];
  paulIds?: string[];
  jacobIds?: string[];
  costFlagSaleIds?: Set<string>;
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
  const { report, inventory, received, payoutCtx, overrides, money, duplicateHidden, duplicateDecisions, ledgerBalances, paulIds, jacobIds, costFlagSaleIds } = input;
  const costAudit = {
    missing: listTrulyMissingCostSales(report.sales || []),
    flaggedDefaults: listFlaggedDefaultCostSales(report.sales || [], costFlagSaleIds || new Set()),
  };
  const attributed = new Set(report.books_attributed_fee_ids || []);
  const staffNames = new Map(payoutCtx.staff.map((s) => [s.user_id, s.display_name]));
  let built = buildExpenses(report, attributed, staffNames);

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
  const saleById = new Map((report.sales || []).map((r) => [String(r.id), r]));
  const salesLines = computed.salesLines.map((s) => {
    const src = saleById.get(s.sale_id) || { id: s.sale_id, profit_cents: s.profit_cents, cost_cents: s.cost_cents };
    return {
      ...s,
      channel: channelTitle(s.channel),
      profit_notes: saleWhyText(src, report),
    };
  });

  const totals = computed.totals;
  const payouts = buildPayouts(report, totals, payoutCtx, money, overrides, ledgerBalances);

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

  const ledgerOwed = ledgerBalances && paulIds && jacobIds
    ? ledgerOwedFromBalances(ledgerBalances, paulIds, jacobIds)
    : undefined;
  const shell: BooksWorkbook = {
    expenses: built,
    sales: { rows: salesLines, channelTotals, totals },
    payouts,
    inventory,
    received: filterReceived(received) as ReceivedItem[],
    manifested_units: manifestedItemCount(report.manifests),
    proof: computed.proof,
    audit: computed.audit,
    costAudit,
  };
  const integrity = verifyBooksIntegrity(shell, report, ledgerOwed);
  const exportTieIssues = verifyExportTies({ ...shell, integrity, exportTieIssues: undefined });

  return {
    expenses: built,
    sales: { rows: salesLines, channelTotals, totals },
    payouts,
    inventory,
    received: filterReceived(received) as ReceivedItem[],
    manifested_units: manifestedItemCount(report.manifests),
    proof: computed.proof,
    audit: computed.audit,
    costAudit,
    integrity,
    exportTieIssues,
  };
}

function priorMonthStart(periodStart: string) {
  const d = new Date(`${periodStart}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

export async function loadBooksMoneySnapshots(client: import('@supabase/supabase-js').SupabaseClient, periodStart: string) {
  const start = priorMonthStart(periodStart);
  const [a, b] = await Promise.all([
    client.rpc('portal_books_money_snapshots', { p_period_start: start }),
    client.rpc('portal_books_money_snapshots', { p_period_start: periodStart }),
  ]);
  const asRows = (res: typeof a) => ((res.data || []) as { account: string; balance_cents: number }[]);
  return { start: a.error ? undefined : asRows(a), end: b.error ? undefined : asRows(b) };
}

export async function loadBooksMoney(client: import('@supabase/supabase-js').SupabaseClient, periodStart?: string) {
  const overviewRes = await client.rpc('portal_money_overview');
  if (overviewRes.error) throw overviewRes.error;
  const overview = ((overviewRes.data || []) as MoneyOverviewRow[]);
  const accounts = ['ebay', 'depop', 'square', 'tiktok', 'amazon', 'safe'];
  const activityByAccount: Record<string, MoneyActivityRow[]> = {};
  await Promise.all(accounts.map(async (acct) => {
    const { data, error } = await client.rpc('portal_money_activity', { p_account: acct, p_limit: 500, p_offset: 0 });
    if (error) return;
    activityByAccount[acct] = ((data as { rows: MoneyActivityRow[] })?.rows || []);
  }));
  const snapshots = periodStart ? await loadBooksMoneySnapshots(client, periodStart).catch(() => undefined) : undefined;
  return { overview, activityByAccount, snapshots };
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
