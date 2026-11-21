import { pacificStamp, todayPacific } from './pacificDay.ts';
import { receivedInventoryCounts } from './receivedSummary.ts';
import type { BooksWorkbook, Period } from './types';

const REASONS: Record<string, string> = {
  starting_cash: 'Starting cash',
  change_for_drawer: 'Change for the drawer',
  moved_from_square: 'Moved from Square',
  moved_from_safe: 'Moved from the safe',
  owner_put_in: 'Owner put money in',
  count_correction: 'Count correction',
  owner_draw: 'Owner took money out',
  person_payout: 'Commission or payout',
  bank_deposit: 'Recorded transfer to the bank',
  supplies: 'Supplies',
  gave_change: 'Gave change',
  move_to_square: 'Moved to Square',
  move_to_safe: 'Moved to the safe',
  counted: 'Counted',
  other: 'Other',
};

export function moneyReasonLabel(reason: unknown): string {
  const key = String(reason || '').trim();
  if (!key) return '';
  return REASONS[key] || key.replace(/_/g, ' ');
}

export function reportTiming(period: Period, generated: Date, word = 'month') {
  const today = todayPacific(generated);
  const coversToday = today >= period.period_start && today <= period.period_end;
  const locked = period.status === 'locked';
  const preliminary = !locked;
  let status = 'Not locked — figures can still change';
  if (locked) status = 'Final — locked';
  else if (coversToday) status = word === 'month' ? 'Month to date — preliminary' : 'Period to date — preliminary';
  return {
    start: period.period_start,
    end: period.period_end,
    timezone: 'America/Los_Angeles',
    generated: pacificStamp(generated),
    today,
    status,
    preliminary,
    cutoff: locked
      ? 'This period is locked. Activity after the lock is not in this file.'
      : `Activity is included through ${pacificStamp(generated)} Pacific. Anything after that is not in this file. This is not a finished month-end balance.`,
  };
}

export function inventoryFlow(wb: BooksWorkbook) {
  const inv = wb.inventory;
  const returned = inv?.return_to_stock_units ?? 0;
  const start = Number(inv?.start_unit_count || 0);
  const received = Number(inv?.received_units || 0);
  const sold = Number(inv?.sold_units || 0);
  const given = Number(inv?.giveaway_units || 0);
  const replacements = Number(inv?.replacement_units || 0);
  const defective = Number(inv?.defective_units || 0);
  const end = Number(inv?.end_unit_count || 0);
  const calculated = start + received + returned - sold - given - replacements - defective;
  return { start, received, returned, sold, given, replacements, defective, end, calculated, ties: calculated === end };
}

export function expenseTie(wb: BooksWorkbook) {
  const recorded = Number(wb.expenses?.total_cents || 0);
  const operating = Number(wb.expenses?.otherExpenses_cents || 0);
  const bonus = Number(wb.expenses?.bonus_cents || 0);
  const already = recorded - operating - bonus;
  const reimburse = Number(wb.expenses?.reimburse_cents || 0);
  return { recorded, already, operating, bonus, reimburse, ties: recorded === already + operating + bonus };
}

export function giveawayOverlap(wb: BooksWorkbook) {
  const expense = (wb.expenses?.categoryTotals || [])
    .filter((row) => /give/i.test(row.category))
    .reduce((sum, row) => sum + row.amount_cents, 0);
  const stock = (wb.inventory?.giveaways || []).reduce((sum, row) => sum + Number(row.cost_cents || 0), 0);
  return { expense, stock, both: expense > 0 && stock > 0 };
}

export function commissionTie(wb: BooksWorkbook) {
  const people = (wb.payouts?.commissions || []).filter((row) => row.role === 'staff');
  const named = people.reduce((sum, row) => sum + row.earned_cents, 0);
  const deducted = Number(wb.sales?.totals?.commission || 0);
  return { people, named, deducted, gap: deducted - named };
}

export function missingCostPicture(wb: BooksWorkbook) {
  const sales = wb.sales?.rows || [];
  const received = receivedInventoryCounts(wb.received || []);
  return {
    sales: sales.length,
    unknownSales: sales.filter((row) => row.cost_cents == null).length,
    zeroCostSales: sales.filter((row) => row.cost_cents === 0).length,
    receivedSkus: received.skus,
    receivedUnits: received.units,
    receivedMissing: received.missing_cost_units,
    receivedKnownCost: received.cost_cents,
    endCost: wb.inventory?.owner?.value?.end_cost_cents,
    endFloor: wb.inventory?.owner?.value?.end_floor_cents,
  };
}

export const COVERAGE = [
  'This workbook is the store\'s books for the dates above. Dates are Pacific time.',
  'It includes sales that were not voided, the fees and labels on those sales, returns recorded in the period, expenses entered in books, inventory movement, items inventoried, manifest counts, recorded platform and safe balances, and commissions calculated from those sales.',
  'It does not include a bank statement, loans, or expenses that were never entered here. A reimbursement from an earlier month stays on the expenses until it is paid back. Profit and platform balances are not spendable cash. A recorded transfer is not a deposit that has been matched to the bank.',
  'Sales tax collected is money held for the state. The Sales tax return tab is a worksheet. Floor does not file it and does not validate it with CDTFA.',
].join(' ');
