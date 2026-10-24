import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Entry = { id: string; spent_on: string; description: string; amount_cents: number };
const todayLA = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const amountInput = /^\d*(?:\.\d{0,2})?$/;

export function OverheadPage({ client, money, native, onBack }: { client: SupabaseClient; money: (n: number) => string; native?: boolean; onBack: () => void }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayLA);
  const [showForm, setShowForm] = useState(!native);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const all: Entry[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error: e } = await client.from('portal_overhead')
          .select('id,spent_on,description,amount_cents').is('voided_at', null)
          .order('spent_on', { ascending: false }).order('created_at', { ascending: false })
          .range(offset, offset + 499);
        if (e) throw e;
        all.push(...((data || []) as Entry[]));
        if (!data || data.length < 500) break;
      }
      setRows(all);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);

  function clearForm() { setEditing(null); setDescription(''); setAmount(''); setDate(todayLA()); setShowForm(!native); }
  function edit(row: Entry) {
    setEditing(row.id); setDescription(row.description); setAmount((row.amount_cents / 100).toFixed(2)); setDate(row.spent_on); setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    const cents = Math.round(Number(amount) * 100);
    if (!description.trim()) { setError('Enter what the cost was for.'); return; }
    if (!date) { setError('Choose a date.'); return; }
    if (!Number.isSafeInteger(cents) || cents <= 0) { setError('Enter an amount greater than zero.'); return; }
    setBusy(true);
    const args = { p_spent_on: date, p_description: description.trim(), p_amount_cents: cents };
    const { error: e } = editing
      ? await client.rpc('portal_update_overhead', { p_id: editing, ...args })
      : await client.rpc('portal_add_overhead', args);
    setBusy(false);
    if (e) { setError(e.message); return; }
    clearForm(); await load();
  }
  async function remove() {
    if (!editing || !window.confirm('Delete this overhead entry?')) return;
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_delete_overhead', { p_id: editing });
    setBusy(false);
    if (e) { setError(e.message); return; }
    clearForm(); await load();
  }
  const total = rows.reduce((n, row) => n + row.amount_cents, 0);
  const form = <form onSubmit={e => void save(e)}>
    <label>What was the cost for?<input autoFocus value={description} placeholder="Rent, utilities, supplies…" onChange={e => setDescription(e.target.value)} /></label>
    <label>Amount ($)<input inputMode="decimal" value={amount} onChange={e => { if (amountInput.test(e.target.value)) setAmount(e.target.value); }} /></label>
    <label>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
    <div className="actions"><button disabled={busy}>{editing ? 'Save changes' : 'Add overhead'}</button>{editing && <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>Delete</button>}</div>
  </form>;

  if (native) return <div className="native-report-body">
    <button type="button" className="native-report-period" onClick={onBack}>‹ Back to Profit</button>
    <div className="native-report-hero"><small>Overhead · All time</small><strong>{loading ? <span className="native-skeleton" /> : money(total)}</strong><span>{rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</span></div>
    {error && <p className="error" role="alert">{error}</p>}
    {!showForm && <button type="button" className="native-report-period" onClick={() => setShowForm(true)}>+ Add overhead</button>}
    {showForm && <section className="native-report-form"><div className="native-report-form-head"><h2>{editing ? 'Edit overhead' : 'Add overhead'}</h2><button type="button" onClick={clearForm}>Close</button></div>{form}</section>}
    <h3 className="native-report-section">Entries</h3><div className="native-report-group">{rows.length ? rows.map(row => <button type="button" className="native-report-row" key={row.id} onClick={() => edit(row)}><span>{row.description}<small>{row.spent_on}</small></span><b>{money(row.amount_cents)}</b><span className="native-chevron">›</span></button>) : !loading && <p className="native-report-empty">No overhead entries yet.</p>}</div>
  </div>;

  return <><div className="section-head"><div><h2>Overhead</h2><p className="hint">Enter each cost separately. These amounts reduce Net on the Profit report.</p></div><button type="button" className="secondary" onClick={onBack}>Back to Profit</button></div>
    <div className="stats"><div className="stat"><span>All time overhead</span><strong>{money(total)}</strong></div></div>
    <section className="panel"><h2>{editing ? 'Edit overhead' : 'Add overhead'}</h2><div className="exp-form">{form}</div>{error && <p className="error" role="alert">{error}</p>}</section>
    <section className="panel"><h2>Entries</h2>{loading ? <p>Loading…</p> : rows.length ? <div className="table-wrap"><table><thead><tr><th>Date</th><th>What</th><th>Amount</th><th /></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td>{row.spent_on}</td><td>{row.description}</td><td>{money(row.amount_cents)}</td><td><button type="button" className="text-button" onClick={() => edit(row)}>Edit</button></td></tr>)}</tbody></table></div> : <p>No overhead entries yet.</p>}</section>
  </>;
}
