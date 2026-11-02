import { commissionBreakdown, type TicketLike } from './payouts';

type Person = { name: string; cents: number | null; pct: string };

/** The real commission math for one sale, line by line, ending in each person's share. */
export function CommissionMath({ ticket, absorbFees, money, people, recordedBaseCents, frozen }: {
  ticket: TicketLike;
  absorbFees: boolean;
  money: (cents: number) => string;
  people: Person[];
  /** When set, commission was frozen at sale — show this base (matches owed amounts), not live ledger drift. */
  recordedBaseCents?: number | null;
  frozen?: boolean;
}) {
  if (frozen) {
    const base = recordedBaseCents;
    return <details className="commission-calculation"><summary>Sale calculation & recorded payouts</summary><table className="commission-math">
      <tbody>
        <tr className="total"><td>= Commission profit (recorded at sale)</td><td className="amt">{base == null ? 'Needs cost' : money(base)}</td><td className="note" /></tr>
        {people.map(p => <tr key={p.name} className="person"><td>{p.name} {p.pct}</td><td className="amt">{p.cents === null ? 'Needs cost' : money(p.cents)}</td><td /></tr>)}
      </tbody>
    </table><p className="hint">Owed amounts use the recorded commission from when this sale was finalized. They stay in sync with the +/− on each row above.</p></details>;
  }
  const { rows, base, absorbedCents } = commissionBreakdown(ticket, absorbFees);
  return <details className="commission-calculation"><summary>Sale calculation & recorded payouts</summary><table className="commission-math">
    <tbody>
      {rows.map(r => <tr key={r.label} className={r.note ? 'absorbed' : undefined}>
        <td>{r.label}</td>
        <td className="amt">{r.note?.startsWith('missing') ? 'Cost missing' : r.note?.startsWith('absorbed') ? <s>{money(Math.abs(r.cents))}</s> : money(r.cents)}</td>
        <td className="note">{r.note || ''}</td>
      </tr>)}
      <tr className="total"><td>= Commission profit</td><td className="amt">{base === null ? 'Needs cost' : money(base)}</td>
        <td className="note">{absorbFees && absorbedCents > 0 ? `store absorbed ${money(absorbedCents)} in fees` : ''}</td></tr>
      {people.map(p => <tr key={p.name} className="person"><td>{p.name} {p.pct}</td><td className="amt">{p.cents === null ? 'Needs cost' : money(p.cents)}</td><td /></tr>)}
    </tbody>
  </table></details>;
}
