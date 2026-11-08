import { channelTitle } from './booksMath';
import type { BookTotals, PayoutsWorkbook, Report, Row, StorePayoutGroup } from './types';

function withdrawalRows(report: Report): Row[] {
  return (report.withdrawals || []).filter((w) => !w.voided_at && Number(w.amount_cents || 0) > 0);
}

export function buildPayouts(report: Report, totals: BookTotals): PayoutsWorkbook {
  const byPlatform = new Map<string, StorePayoutGroup>();
  for (const w of withdrawalRows(report)) {
    const raw = String(w.source || 'unknown').toLowerCase();
    const channel = channelTitle(raw === 'safe' ? 'Safe cash' : raw);
    const g = byPlatform.get(channel) || { channel, count: 0, total_cents: 0, payouts: [] };
    g.count += 1;
    g.total_cents += Number(w.amount_cents || 0);
    g.payouts.push(w);
    byPlatform.set(channel, g);
  }
  const stores = [...byPlatform.values()].sort((a, b) => b.total_cents - a.total_cents);
  const storePaidTotal_cents = stores.reduce((n, s) => n + s.total_cents, 0);

  let notPaidYet_cents = 0;
  for (const row of report.money_trail || []) {
    const status = String(row.status || '');
    if (!/not matched|in transit|awaiting|not linked|not recorded/i.test(status)) continue;
    const cents = Number(row.platform_payout_cents ?? row.sale_cents ?? 0);
    if (cents > 0) notPaidYet_cents += cents;
  }

  const commissions = (report.payout_balances || []).map((b) => {
    const earned = Number(b.commission_earned_cents || 0);
    const paid = Number(b.payments_cents || 0);
    const owed = Number(b.ending_balance_cents ?? Math.max(0, earned - paid));
    return {
      person: String(b.person || 'Staff'),
      earned_cents: earned,
      paid_cents: paid,
      owed_cents: owed,
    };
  });
  const commission_total_cents = commissions.reduce((n, c) => n + c.earned_cents, 0);
  const stillOwed_cents = commissions.reduce((n, c) => n + c.owed_cents, 0);

  const owner = {
    profit: totals.profit,
    commission: totals.commission,
    otherExpenses: totals.otherExpenses,
    ownerKeeps: totals.ownerKeeps,
  };

  return { stores, notPaidYet_cents, storePaidTotal_cents, commissions, commission_total_cents, stillOwed_cents, owner };
}
