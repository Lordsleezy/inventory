import { commissionBreakdown, type TicketLike } from './payouts';

type Person = { name: string; cents: number | null; pct: string };

/** The real commission math for one sale, line by line, ending in each person's share. */
export function CommissionMath({ ticket, absorbFees, money, people, frozenBase }: {
  ticket: TicketLike; absorbFees: boolean; money: (cents: number) => string; people: Person[];
  /** When set, prefer the recorded sale_commissions base over live browser math. */
  frozenBase?: number | null;
}) {
  const { rows, base, absorbedCents } = commissionBreakdown(ticket, absorbFees);
  const displayBase = frozenBase !== undefined ? frozenBase : base;
  const frozenNote = frozenBase !== undefined
    ? (absorbFees && absorbedCents > 0
      ? `frozen at sale · store absorbed ${money(absorbedCents)} in fees`
      : 'frozen at sale')
    : (absorbFees && absorbedCents > 0 ? `store absorbed ${money(absorbedCents)} in fees` : '');
  return <details className="commission-calculation"><summary>Sale calculation & recorded payouts</summary><table className="commission-math">
    <tbody>
      {rows.map(r => <tr key={r.label} className={r.note ? 'absorbed' : undefined}>
        <td>{r.label}</td>
        <td className="amt">{r.note?.startsWith('missing') ? 'Cost missing' : r.note?.startsWith('absorbed') ? <s>{money(Math.abs(r.cents))}</s> : money(r.cents)}</td>
        <td className="note">{r.note || ''}</td>
      </tr>)}
      <tr className="total"><td>= Commission profit</td><td className="amt">{displayBase === null ? 'Needs cost' : money(displayBase)}</td>
        <td className="note">{frozenNote}</td></tr>
      {people.map(p => <tr key={p.name} className="person"><td>{p.name} {p.pct}</td><td className="amt">{p.cents === null ? 'Needs cost' : money(p.cents)}</td><td /></tr>)}
    </tbody>
  </table></details>;
}
