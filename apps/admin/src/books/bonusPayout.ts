export type BonusPayoutLine = { person: string; cents: number; note: string };

type ExpenseLike = {
  employee_id?: string | null;
  category?: string;
  description?: string;
  amount_cents?: number;
  spent_on?: string;
  date?: string;
  voided_at?: string | null;
};

type AdjustmentLike = {
  employee_id?: string | null;
  amount_cents?: number;
  reason?: string;
};

function dollars(cents: number) {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isBonusExpense(row: ExpenseLike) {
  if (row.voided_at) return false;
  const category = String(row.category || '').trim().toLowerCase();
  return category === 'bonus' || /bonus/i.test(String(row.description || ''));
}

/**
 * Bonuses on the payout. A bonus entered earlier stays in the total when this period
 * gives part of it to someone else, and the line shows what is left.
 */
export function bonusPayoutLines(
  expenses: ExpenseLike[],
  priorBonuses: ExpenseLike[],
  adjustments: AdjustmentLike[],
  personName: (employeeId: string) => string,
): BonusPayoutLine[] {
  const bonusAdj = (adjustments || []).filter((row) => /bonus/i.test(String(row.reason || '')) && Number(row.amount_cents));
  const reduced = new Set(
    bonusAdj.filter((row) => Number(row.amount_cents) < 0).map((row) => personName(String(row.employee_id || ''))),
  );
  const parts = new Map<string, { cents: number; label: string }[]>();
  const add = (person: string, cents: number, label: string) => {
    if (!person || !cents) return;
    const list = parts.get(person) || [];
    list.push({ cents, label });
    parts.set(person, list);
  };
  for (const row of expenses || []) {
    if (!isBonusExpense(row)) continue;
    add(personName(String(row.employee_id || '')), Number(row.amount_cents || 0), String(row.description || 'Bonus'));
  }
  for (const row of priorBonuses || []) {
    if (!isBonusExpense(row)) continue;
    const person = personName(String(row.employee_id || ''));
    if (!reduced.has(person)) continue;
    add(person, Number(row.amount_cents || 0), `${row.description || 'Bonus'} entered ${row.spent_on || row.date || 'earlier'}`);
  }
  for (const row of bonusAdj) {
    add(personName(String(row.employee_id || '')), Number(row.amount_cents || 0), String(row.reason || 'Bonus'));
  }
  const receiver = bonusAdj.find((row) => Number(row.amount_cents) > 0);
  const receiverName = receiver ? personName(String(receiver.employee_id || '')) : '';
  const lines: BonusPayoutLine[] = [];
  for (const [person, list] of parts) {
    const cents = list.reduce((sum, part) => sum + part.cents, 0);
    if (!cents) continue;
    const gave = list.find((part) => part.cents < 0);
    const started = list.filter((part) => part.cents > 0).reduce((sum, part) => sum + part.cents, 0);
    const note = gave && started > cents
      ? `${person} ${dollars(cents)}. Was ${dollars(started)}. ${dollars(Math.abs(gave.cents))} was given to ${receiverName || 'the other person'}.`
      : `${person} ${dollars(cents)}. ${list.map((part) => `${part.label} ${dollars(part.cents)}`).join('; ')}.`;
    lines.push({ person, cents, note });
  }
  return lines;
}
