import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { DispositionsPanel } from './DispositionDialogs';

export type Expense = {
  id: string; spent_on: string; description: string; category: string; amount_cents: number;
  needs_reimbursement: boolean; employee_id: string | null; source: 'manual' | 'label' | 'giveaway'; order_id: string | null; voided_at: string | null;
};
type Person = { user_id: string; display_name: string; kind: string };
type Props = { client: SupabaseClient; money: (n: number) => string; expenses: Expense[]; staff: Person[]; ownerId: string; onChanged: () => Promise<void>; embedded?: boolean; native?: boolean };

const zone = 'America/Los_Angeles';
const todayLA = () => new Date().toLocaleDateString('en-CA', { timeZone: zone });
const CATEGORIES = ['Supplies', 'Inventory', 'Shipping', 'Shipping supplies', 'Labels', 'Subscriptions', 'Advertising', 'Equipment', 'Other'];
const entry = /^\d*(?:\.\d{0,2})?$/;

/** Everything bought for the store: fast to add, and reimbursable expenses feed the payout balance. */
export function ExpensesPage({ client, money, expenses, staff, ownerId, onChanged, embedded, native }: Props) {
  const blank = { what: '', amount: '', date: todayLA(), category: 'Supplies', reimburse: true, who: ownerId };
  const [f, setF] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [range, setRange] = useState<'day' | 'week' | 'month' | 'all' | 'custom'>('month');
  const [customStart, setCustomStart] = useState(todayLA());
  const [customEnd, setCustomEnd] = useState(todayLA());
  const [showDates, setShowDates] = useState(false);
  const [summary, setSummary] = useState<{ expense_cents: number; expenses: { category: string; cents: number }[] } | null>(null);
  const [summaryError, setSummaryError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const name = (id: string | null) => staff.find(p => p.user_id === id)?.display_name || '—';
  const month = todayLA().slice(0, 7);
  const live = useMemo(() => expenses.filter(e => !e.voided_at), [expenses]);
  const monthTotal = live.filter(e => e.spent_on.startsWith(month)).reduce((n, e) => n + e.amount_cents, 0);
  const owed = live.filter(e => e.needs_reimbursement).reduce((n, e) => n + e.amount_cents, 0);
  const now = todayLA();
  const week = new Date(); week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
  const start = range === 'custom' ? customStart : range === 'day' ? now : range === 'week' ? week.toLocaleDateString('en-CA', { timeZone: zone }) : range === 'month' ? `${month}-01` : '2020-01-01';
  const end = range === 'custom' ? customEnd : now;
  useEffect(() => {
    if (!native) return;
    let alive = true;
    setSummary(null); setSummaryError('');
    const after = new Date(`${end}T12:00:00Z`); after.setUTCDate(after.getUTCDate() + 1);
    void Promise.resolve(client.rpc('portal_channel_report', { p_start: start, p_end: after.toISOString().slice(0,10) }))
      .then(({ data, error: err }) => { if (alive && !err) setSummary(data as { expense_cents: number; expenses: { category: string; cents: number }[] }); else if (alive && err) setSummaryError(err.message); })
      .catch(e => { if (alive) setSummaryError(String(e)); });
    return () => { alive = false; };
  }, [client, native, start, end, refresh]);
  useEffect(() => {
    if (!native) return;
    const add = () => { setEditing(null); setF(blank); setShowForm(true); };
    window.addEventListener('floor:reports-action', add);
    return () => window.removeEventListener('floor:reports-action', add);
  }, [native, ownerId]);

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
    setF({ ...blank, date: f.date, category: f.category, who: f.who }); setEditing(null); setShowForm(false);
    await onChanged(); setRefresh(n => n + 1);
  }
  async function remove(id: string) {
    if (!window.confirm('Delete this expense? It comes off the reimbursement balance.')) return false;
    const { error: e } = await client.rpc('portal_delete_expense', { p_id: id });
    if (e) { setError(e.message); return false; }
    await onChanged(); setRefresh(n => n + 1); return true;
  }
  function edit(e: Expense) {
    setEditing(e.id); setF({ what: e.description, amount: (e.amount_cents / 100).toFixed(2), date: e.spent_on, category: e.category, reimburse: e.needs_reimbursement, who: e.employee_id || ownerId });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (native) {
    const shown = live.filter(e => e.spent_on >= start && e.spent_on <= end && !['label','manual_label','ebay'].includes(e.source));
    const total = summary?.expense_cents ?? shown.reduce((n, e) => n + e.amount_cents, 0);
    const categories = summary?.expenses?.map(e => [e.category || 'Other', e.cents] as [string,number]) || Array.from(shown.reduce((m, e) => m.set(e.category || 'Other', (m.get(e.category || 'Other') || 0) + e.amount_cents), new Map<string, number>()));
    return <div className="native-report-body">
      <div className="native-report-segment" role="group" aria-label="Date range">{(['day','week','month','all'] as const).map(k => <button type="button" key={k} className={range === k ? 'selected' : ''} onClick={() => setRange(k)}>{k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)}</button>)}</div><button type="button" className="native-report-period" onClick={() => setShowDates(v => !v)} aria-expanded={showDates}>{start} – {end} ▾</button>{showDates && <div className="native-report-dates"><label>From<input type="date" value={customStart} onChange={e => { setRange('custom'); setCustomStart(e.target.value); }} /></label><label>To<input type="date" value={customEnd} onChange={e => { setRange('custom'); setCustomEnd(e.target.value); }} /></label></div>}
      <div className="native-report-hero"><small>Expenses · {range === 'all' ? 'All time' : range === 'month' ? month : range === 'week' ? 'This week' : 'Today'}</small><strong>{summary || summaryError ? money(total) : <span className="native-skeleton" />}</strong><span>{summaryError ? 'Showing loaded expenses only' : 'Excludes labels already in Shipping & fees'}</span></div>
      {showForm && <section className="native-report-form"><div className="native-report-form-head"><h2>{editing ? 'Edit expense' : 'Add expense'}</h2><button type="button" onClick={() => setShowForm(false)}>Close</button></div><form onSubmit={e => void submit(e)}><label>What<input autoFocus value={f.what} onChange={e => setF({...f,what:e.target.value})} /></label><label>Amount ($)<input inputMode="decimal" value={f.amount} onChange={e => { if (entry.test(e.target.value)) setF({...f,amount:e.target.value}); }} /></label><label>Date<input type="date" value={f.date} onChange={e => setF({...f,date:e.target.value})} /></label><label>Category<select value={f.category} onChange={e => setF({...f,category:e.target.value})}>{CATEGORIES.map(c=><option key={c}>{c}</option>)}</select></label><label><input type="checkbox" checked={f.reimburse} onChange={e=>setF({...f,reimburse:e.target.checked})} /> Reimburse me</label>{f.reimburse && <label>Reimburse to<select value={f.who} onChange={e=>setF({...f,who:e.target.value})}>{staff.map(p=><option key={p.user_id} value={p.user_id}>{p.display_name}</option>)}</select></label>}<button disabled={busy}>{editing ? 'Save changes' : 'Add expense'}</button>{editing && <button type="button" className="danger" disabled={busy} onClick={() => { void remove(editing).then(deleted => { if (deleted) setShowForm(false); }); }}>Delete expense</button>}</form>{error && <p role="alert" className="error">{error}</p>}</section>}
      <h3 className="native-report-section">By category</h3><div className="native-report-group">{categories.length ? categories.sort((a,b)=>b[1]-a[1]).map(([category,cents]) => <div className="native-report-category" key={category}><div className="native-report-row"><span>{category}</span><b>{money(cents)}</b><span className="native-chevron">›</span></div><div className="native-report-progress"><span style={{width:`${total ? cents / total * 100 : 0}%`}} /></div></div>) : <p className="native-report-empty">No expenses in this period.</p>}</div>
      <h3 className="native-report-section">Recent</h3><div className="native-report-group">{shown.slice(0, 30).map(e => <button type="button" className="native-report-row" key={e.id} onClick={() => e.source === 'manual' && edit(e)}><span>{e.description}<small>{e.spent_on} · {name(e.employee_id)} · {e.needs_reimbursement ? 'Reimburse' : 'Paid'}</small></span><b>{money(e.amount_cents)}</b>{e.source === 'manual' && <span className="native-chevron">›</span>}</button>)}</div>
      <DispositionsPanel client={client} money={money} stamp={s => new Date(s).toLocaleDateString()} kind="giveaway" title="Giveaways" refreshKey={refresh} onChanged={() => { void onChanged(); setRefresh(n => n + 1); }} />
      <p className="native-report-footnote">Reimbursable expenses also appear in Payouts. Automatic label costs are included in Shipping &amp; fees.</p>
    </div>;
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
          <td>{e.spent_on}</td><td>{e.description}{e.source === 'label' && <> <span className="tag">auto</span></>}{e.source === 'giveaway' && <> <span className="tag">giveaway</span></>}{e.voided_at && <> <span className="tag warn">voided</span></>}</td><td>{e.category}</td>
          <td className="n">{money(e.amount_cents)}</td><td>{e.needs_reimbursement ? name(e.employee_id) : 'No'}</td>
          <td>{e.source === 'manual' && !e.voided_at && <><button className="text-button" onClick={() => edit(e)}>Edit</button> <button className="text-button danger" onClick={() => void remove(e.id)}>Delete</button></>}</td></tr>)}
      </tbody></table>}
    </section>
    <DispositionsPanel client={client} money={money} stamp={s => new Date(s).toLocaleDateString()} kind="giveaway" title="Giveaways" hint="Items given away. Their cost posts here as the Giveaways expense category and never touches commissions. Cost missing means no unit cost is entered yet." refreshKey={refresh} onChanged={() => { void onChanged(); setRefresh(n => n + 1); }} />
  </>;
}
