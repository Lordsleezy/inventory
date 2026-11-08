import { isBonusCategory } from '../payouts';
import { channelTitle } from './booksMath';
import { canonicalPersonKey, canonicalPersonLabel, mergeEmployeeIds } from './personMerge';
import { computePayoutPersonBalances, type PersonBalance } from './payoutLedger';
import { cutCommission, frozenTickets, ticketsFromReportSales } from './payoutTickets';
import type {
  BookTotals,
  BooksPayoutContext,
  CommissionPayoutLine,
  MoneyActivityRow,
  PayoutsWorkbook,
  Report,
  StoreMoneyMonth,
} from './types';
import type { CommissionOverride } from '../payouts';

const MONEY_NAMES: Record<string, string> = {
  safe: 'Safe cash',
  square: 'Square',
  ebay: 'eBay',
  depop: 'Depop',
  mercari: 'Mercari',
  amazon: 'Amazon',
  tiktok: 'TikTok',
};

const ACTIVE_ACCOUNTS = ['ebay', 'depop', 'square', 'tiktok', 'amazon', 'safe'];

function inMonth(iso: string, start: string, end: string) {
  const d = iso.slice(0, 10);
  return d >= start && d <= end;
}

export type MoneyOverviewRow = { account: string; balance_cents: number };
export type MoneyMonthSnapshot = { account: string; balance_cents: number };

export function buildMoneyMonths(
  periodStart: string,
  periodEnd: string,
  overview: MoneyOverviewRow[],
  activityByAccount: Record<string, MoneyActivityRow[]>,
  snapshots?: { start?: MoneyMonthSnapshot[]; end?: MoneyMonthSnapshot[] },
): StoreMoneyMonth[] {
  const stores: StoreMoneyMonth[] = [];
  for (const acct of ACTIVE_ACCOUNTS) {
    const rows = (activityByAccount[acct] || []).filter((r) => inMonth(r.at, periodStart, periodEnd));
    const moneyIn = rows.filter((r) => r.direction === 'in').reduce((n, r) => n + r.amount_cents, 0);
    const outs = rows.filter((r) => r.direction === 'out');
    const paidOut = outs.reduce((n, r) => n + r.amount_cents, 0);
    const ov = overview.find((o) => o.account === acct);
    const snapEnd = snapshots?.end?.find((s) => s.account === acct);
    const snapStart = snapshots?.start?.find((s) => s.account === acct);
    const endBal = snapEnd?.balance_cents ?? ov?.balance_cents ?? null;
    const startFromSnap = snapStart?.balance_cents ?? null;
    const startBal = startFromSnap ?? (endBal == null ? null : endBal - moneyIn + paidOut);
    const transfers = outs;
    stores.push({
      account: acct,
      label: MONEY_NAMES[acct] || channelTitle(acct),
      start_balance_cents: startBal,
      start_balance_estimated: startFromSnap == null && startBal != null,
      money_in_cents: moneyIn,
      paid_to_bank_cents: paidOut,
      end_balance_cents: endBal,
      end_balance_estimated: snapEnd == null && endBal != null,
      transfers,
    });
  }
  return stores.filter((s) => s.money_in_cents || s.paid_to_bank_cents || s.end_balance_cents);
}

function bonusExpenseIds(report: Report): Set<string> {
  const ids = new Set<string>();
  for (const e of report.expenses || []) {
    if (e.voided_at) continue;
    if (isBonusCategory(String(e.category || ''))) ids.add(String(e.id));
  }
  return ids;
}

export function buildPayouts(
  report: Report,
  totals: BookTotals,
  ctx: BooksPayoutContext,
  money: { overview: MoneyOverviewRow[]; activityByAccount: Record<string, MoneyActivityRow[]>; snapshots?: { start?: MoneyMonthSnapshot[]; end?: MoneyMonthSnapshot[] } },
  overrides: Map<string, CommissionOverride>,
  ledgerBalances?: PersonBalance[],
): PayoutsWorkbook {
  const period = report.period;
  const tickets = ticketsFromReportSales(report.sales || [], overrides);
  const { paulId, jacobId } = mergeEmployeeIds(ctx.staff, ctx.peopleSlots);
  const frozenSet = frozenTickets(ctx.frozen);
  const bonuses = bonusExpenseIds(report);

  const earned = new Map<string, number>([
    ['paul', 0],
    ['jacob', 0],
  ]);

  const paulIds: string[] = [];
  const jacobIds: string[] = [];
  for (const s of ctx.staff) {
    const key = canonicalPersonKey(s.display_name, s.email);
    if (key === 'paul') paulIds.push(s.user_id);
    if (key === 'jacob') jacobIds.push(s.user_id);
  }
  if (paulId && !paulIds.includes(paulId)) paulIds.push(paulId);
  if (jacobId && !jacobIds.includes(jacobId)) jacobIds.push(jacobId);

  for (const t of tickets) {
    for (const rule of ctx.rules) {
      const amount = cutCommission(t.key, t, rule, ctx.frozen, ctx.cfg, frozenSet);
      if (amount == null) continue;
      if (paulIds.includes(rule.employee_id)) earned.set('paul', (earned.get('paul') || 0) + amount);
      if (jacobIds.includes(rule.employee_id)) earned.set('jacob', (earned.get('jacob') || 0) + amount);
    }
  }

  const paidMonth = (empIds: string[]) => (report.payments || [])
    .filter((p) => {
      if (!empIds.includes(String(p.employee_id))) return false;
      if (!inMonth(String(p.paid_at || ''), period.period_start, period.period_end)) return false;
      const matchesBonus = (report.expenses || []).some((e) => !e.voided_at && bonuses.has(String(e.id))
        && Number(e.amount_cents) === Number(p.amount_cents)
        && String(e.spent_on || e.date || '').slice(0, 10) === String(p.paid_at || '').slice(0, 10));
      return !matchesBonus;
    })
    .reduce((n, p) => n + Number(p.amount_cents || 0), 0);

  const allTimeOwed = (empIds: string[]) => {
    if (ledgerBalances?.length) {
      return empIds.reduce((n, id) => n + (ledgerBalances.find((b) => b.user_id === id)?.commissionOwed || 0), 0);
    }
    return Math.max(0, empIds.reduce((n, id) => {
      const row = (report.payout_balances || []).find((b) => String(b.id) === id);
      return n + Number(row?.ending_balance_cents || 0);
    }, 0));
  };

  const commissions: CommissionPayoutLine[] = [
    {
      person: canonicalPersonLabel('paul'),
      role: 'staff',
      earned_cents: earned.get('paul') || 0,
      paid_cents: paidMonth(paulIds),
      owed_all_time_cents: allTimeOwed(paulIds),
    },
    {
      person: canonicalPersonLabel('jacob'),
      role: 'staff',
      earned_cents: earned.get('jacob') || 0,
      paid_cents: paidMonth(jacobIds),
      owed_all_time_cents: allTimeOwed(jacobIds),
    },
  ];

  const stores = buildMoneyMonths(period.period_start, period.period_end, money.overview, money.activityByAccount, money.snapshots);
  const bankPaidTotal_cents = stores.reduce((n, s) => n + s.paid_to_bank_cents, 0);

  return {
    stores,
    bankPaidTotal_cents,
    commissions,
    commission_total_cents: (earned.get('paul') || 0) + (earned.get('jacob') || 0),
    stillOwed_all_time_cents: commissions.filter((c) => c.role === 'staff').reduce((n, c) => n + c.owed_all_time_cents, 0),
    owner: {
      profit: totals.profit,
      commission: totals.commission,
      otherExpenses: totals.otherExpenses,
      ownerKeeps: totals.profit - totals.commission - totals.otherExpenses,
    },
  };
}
