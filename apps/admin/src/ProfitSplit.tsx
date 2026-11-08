import { isBonusCategory, payout, payoutDay, ticketIsFrozen, type OnlineCfg, type Rule, type TicketLike } from './payouts';

type Sale = TicketLike & { key: string; at: string };
type Expense = { voided_at: string | null; category: string; employee_id: string | null; spent_on: string; amount_cents: number };

export function ProfitSplit({
  start, end, profitCents, sales, rules, cfg, frozen, expenses, personName, money,
}: {
  start: string;
  end: string;
  profitCents: number;
  sales: Sale[];
  rules: Rule[];
  cfg: OnlineCfg;
  frozen?: Map<string, number | null> | null;
  expenses: Expense[];
  personName: (id: string) => string;
  money: (cents: number) => string;
}) {
  const jacobId = cfg.slots?.jacob || '';
  const paulId = cfg.slots?.paul || '';
  const jacobRule = rules.find(r => r.employee_id === jacobId);
  const paulRule = rules.find(r => r.employee_id === paulId);
  let jacob = 0;
  let paul = 0;
  let pending = 0;
  for (const sale of sales) {
    const day = payoutDay(sale.at);
    if (!day || day < start || day >= end) continue;
    const cut = (rule: Rule | undefined) => {
      if (!rule) return 0;
      if (ticketIsFrozen(frozen, sale.key)) {
        const key = `${sale.key}|${rule.employee_id}`;
        return frozen?.has(key) ? frozen.get(key) ?? null : 0;
      }
      return payout(sale, rule, cfg);
    };
    const parts = [cut(jacobRule), cut(paulRule)];
    if (sale.cost === null || parts.some(part => part === null)) { pending += 1; continue; }
    jacob += parts[0] || 0;
    paul += parts[1] || 0;
  }
  let jacobBonus = 0;
  let paulBonus = 0;
  let otherBonus = 0;
  for (const expense of expenses) {
    if (expense.voided_at || !isBonusCategory(expense.category)) continue;
    if (expense.spent_on < start || expense.spent_on >= end) continue;
    if (expense.employee_id === jacobId) jacobBonus += expense.amount_cents;
    else if (expense.employee_id === paulId) paulBonus += expense.amount_cents;
    else otherBonus += expense.amount_cents;
  }
  jacob += jacobBonus;
  paul += paulBonus;
  const steve = profitCents - jacob - paul - otherBonus;
  const jacobNote = jacobRule ? `${jacobRule.rate}% of commission profit` : 'Commission';
  const paulNote = `${paulRule ? `${paulRule.rate}% in store` : 'In store'} · ${cfg.pct}% online`;
  const rows = [
    { name: personName(jacobId) || 'Jacob', note: jacobNote, cents: jacob },
    { name: personName(paulId) || 'Paul', note: paulNote, cents: paul },
    { name: 'Steve', note: 'After commissions. Marketplace fees stay with the store.', cents: steve },
  ];
  return (
    <>
      <h3 className="rpt-section">Profit split</h3>
      <div className="rpt-rows">
        {rows.map(row => (
          <div className="rpt-line" key={row.name}>
            <span>{row.name}<small>{row.note}</small></span>
            <b>{money(row.cents)}</b>
          </div>
        ))}
      </div>
      {pending > 0 && <p className="rpt-note">{pending} sale{pending === 1 ? '' : 's'} need a cost, so {pending === 1 ? 'it is' : 'they are'} not in these shares.</p>}
      {otherBonus > 0 && <p className="rpt-note">Bonuses paid to someone else ({money(otherBonus)}) come out of Steve’s share.</p>}
    </>
  );
}
