import { useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

export type Expense = {
  id: string; spent_on: string; description: string; category: string; amount_cents: number;
  needs_reimbursement: boolean; employee_id: string | null; source: 'manual' | 'label'; order_id: string | null; voided_at: string | null;
};
type Person = { user_id: string; display_name: string; kind: string };
type Props = { client: SupabaseClient; money: (n: number) => string; expenses: Expense[]; staff: Person[]; ownerId: string; onChanged: () => Promise<void>; embedded?: boolean };

const zone = 'America/Los_Angeles';
const todayLA = () => new Date().toLocaleDateString('en-CA', { timeZone: zone });
const CATEGORIES = ['Supplies', 'Inventory', 'Shipping', 'Shipping supplies', 'Labels', 'Subscriptions', 'Advertising', 'Equipment', 'Other'];
const entry = /^\d*(?:\.\d{0,2})?$/;

/** Everything bought for the store: fast to add, and reimbursable expenses feed the payout balance. */
export function ExpensesPage({ client, money, expenses, staff, ownerId, onChanged, embedded }: Props) {
  const blank = { what: '', amount: '', date: todayLA(), category: 'Supplies', reimburse: true, who: ownerId };
  const [f, setF] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const name = (id: string | null) => staff.find(p => p.user_id === id)?.display_name || '—';
  const month = todayLA().slice(0, 7);
  const live = useMemo(() => expenses.filter(e => !e.voided_at), [expenses]);
  const monthTotal = live.filter(e => e.spent_on.startsWith(month)).reduce((n, e) => n + e.amount_cents, 0);
  const owed = live.filter(e => e.needs_reimbursement).reduce((n, e) => n + e.amount_cents, 0);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault(); setError('');
    const cents = Math.round(Number(f.amount || 0) * 100);
    if (!f.what.trim()) { setError('What was it?'); return; }
    if (!Number.isFinite(cents) || cents <= 0) { setError('Enter the amount.'); return; }
    setBusy(true);
    const args = { p_spent_on: f.date, p_description: f.what.trim(), p_category: f.category, p_amount_cents: cents, p_needs_reimbursement: f.reimburse, p_employee: f.reimburse ? (f.who || null) : null };
    const { error: e } = editing ? await client.rpc('portal_update_expense', { p_id: editing, ...args }) : await client.rpc('portal_add_expense', args);
    setBusy(false);
    if (e) { setError(e.message); return; }
    setF({ ...blank, date: f.date, category: f.category, who: f.who }); setEditing(null);
    await onChanged();
  }
  async function remove(id: string) {
    if (!window.confirm('Delete this expense? It comes off the reimbursement balance.')) return;
    const { error: e } = await client.rpc('portal_delete_expense', { p_id: id });
    if (e) setError(e.message); else await onChanged();
  }
  function edit(e: Expense) {
    setEditing(e.id); setF({ what: e.description, amount: (e.amount_cents / 100).toFixed(2), date: e.spent_on, category: e.category, reimburse: e.needs_reimbursement, who: e.employee_id || ownerId });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  return <>
    {!embedded && <header><div><div className="eyebrow">MONEY OUT</div><h1>Expenses</h1><p>Anything you buy for the store. Check “needs reimbursement” and it is added to that person’s balance on the Payouts screen. Shippo labels are added automatically.</p></div></header>}
    {embedded && <div className="section-head" style={{ marginBottom: 12 }}><div><h2>Expenses</h2><p className="hint" style={{ margin: 0 }}>Store purchases; reimbursable items feed payout balances.</p></div></div>}
    <div className="stats"><div className="stat"><span>This month</span><strong>{money(monthTotal)}</strong></div><div className="stat"><span>Needs reimbursement (all time)</span><strong>{money(owed)}</strong></div></div>
    <section className="panel"><h2>{editing ? 'Edit expense' : 'Add an expense'}</h2>
      <form className="exp-form" onSubmit={e => void submit(e)}>
        <label>What<input autoFocus value={f.what} placeholder="Tape, boxes, inventory lot…" onChange={e => setF({ ...f, what: e.target.value })} /></label>
        <label>Amount ($)<input inputMode="decimal" value={f.amount} onChange={e => { if (entry.test(e.target.value)) setF({ ...f, amount: e.target.value }); }} onBlur={() => f.amount && setF({ ...f, amount: Number(f.amount === '.' ? 0 : f.amount).toFixed(2) })} /></label>
        <label>Date<input type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></label>
        <label>Category<select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>{CATEGORIES.map(c => <option key={c}>{c}</option>)}</select></label>
        <label className="inventory-check"><input type="checkbox" checked={f.reimburse} onChange={e => setF({ ...f, reimburse: e.target.checked })} />I paid — reimburse me</label>
        {f.reimburse && <label>Reimburse to<select value={f.who} onChange={e => setF({ ...f, who: e.target.value })}>{staff.map(p => <option key={p.user_id} value={p.user_id}>{p.display_name}</option>)}</select></label>}
        <div className="actions"><button disabled={busy}>{editing ? 'Save changes' : 'Add expense'}</button>{editing && <button type="button" className="text-button" onClick={() => { setEditing(null); setF(blank); }}>Cancel</button>}</div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
    </section>
    <section className="panel"><h2>Recent expenses</h2>
      {expenses.length === 0 ? <div className="empty">No expenses yet.</div> : <table className="tbl"><thead><tr><th>Date</th><th>What</th><th>Category</th><th className="n">Amount</th><th>Reimburse</th><th /></tr></thead><tbody>
        {expenses.slice(0, 150).map(e => <tr key={e.id} style={e.voided_at ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
          <td>{e.spent_on}</td><td>{e.description}{e.source === 'label' && <> <span className="tag">auto</span></>}{e.voided_at && <> <span className="tag warn">voided</span></>}</td><td>{e.category}</td>
          <td className="n">{money(e.amount_cents)}</td><td>{e.needs_reimbursement ? name(e.employee_id) : 'No'}</td>
          <td>{e.source === 'manual' && !e.voided_at && <><button className="text-button" onClick={() => edit(e)}>Edit</button> <button className="text-button danger" onClick={() => void remove(e.id)}>Delete</button></>}</td></tr>)}
      </tbody></table>}
    </section>
  </>;
}
