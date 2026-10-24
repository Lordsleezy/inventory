import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Source = 'safe' | 'square' | 'ebay' | 'amazon' | 'tiktok' | 'depop';
type Reason = 'bank_deposit' | 'person_payout' | 'owner_draw' | 'other';
type Entry = {
  id: string; source: Source; amount_cents: number; moved_on: string;
  reason: Reason; note: string; person_id: string | null;
  performed_by: string | null;
  created_by: string | null; created_at: string; updated_by: string | null;
  updated_at: string | null; voided_at: string | null;
};
type Balance = {
  source: Source; sales_less_fees_cents: number; refund_cents: number;
  withdrawn_cents: number; expected_cents: number;
};
type Person = { user_id: string; display_name: string };
type Audit = { id: number; action: string; at: string; actor_id: string | null; old_row: Entry | null; new_row: Entry | null };
type Props = { client: SupabaseClient; storeId: string; money: (cents: number) => string; stamp: (value: string) => string };

const SOURCES: { id: Source; label: string }[] = [
  { id: 'safe', label: 'Safe · cash' }, { id: 'square', label: 'Square' },
  { id: 'ebay', label: 'eBay' }, { id: 'amazon', label: 'Amazon' },
  { id: 'tiktok', label: 'TikTok' }, { id: 'depop', label: 'Depop' },
];
const REASONS: { id: Reason; label: string }[] = [
  { id: 'bank_deposit', label: 'Bank deposit' },
  { id: 'person_payout', label: 'Payout to a person' },
  { id: 'owner_draw', label: 'Owner draw' },
  { id: 'other', label: 'Other' },
];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const empty = () => ({ source: 'safe' as Source, amount: '', moved_on: today(), reason: 'bank_deposit' as Reason, person_id: '', performed_by: '', note: '' });
const label = (source: Source) => SOURCES.find((item) => item.id === source)?.label || source;
const reasonLabel = (reason: Reason) => REASONS.find((item) => item.id === reason)?.label || reason;

export function WithdrawalsPage({ client, storeId, money, stamp }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<string | null>(null);
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [entryResult, balanceResult, peopleResult] = await Promise.all([
      client.rpc('portal_withdrawal_entries', { p_limit: 1000 }),
      client.rpc('portal_withdrawal_reconciliation'),
      client.from('staff').select('user_id,display_name').eq('store_id', storeId).is('deactivated_at', null).order('display_name'),
    ]);
    if (entryResult.error) throw entryResult.error;
    if (balanceResult.error) throw balanceResult.error;
    if (peopleResult.error) throw peopleResult.error;
    setEntries((entryResult.data || []) as Entry[]);
    setBalances((balanceResult.data || []) as Balance[]);
    setPeople((peopleResult.data || []) as Person[]);
    setLoaded(true);
  }, [client, storeId]);

  useEffect(() => { void load().catch((e) => setError(String(e.message || e))); }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const amount = Number(form.amount);
    const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || cents <= 0 || Math.abs(amount * 100 - cents) > 0.001) {
      setError('Enter a positive amount with no more than two decimal places.'); return;
    }
    if (form.reason === 'person_payout' && !form.person_id) {
      setError('Choose the person receiving this payout.'); return;
    }
    setBusy(true); setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_save_withdrawal', {
        p_id: editing, p_source: form.source, p_amount_cents: cents, p_on: form.moved_on,
        p_reason: form.reason, p_note: form.note, p_person: form.reason === 'person_payout' ? form.person_id : null,
        p_performer: form.performed_by || null,
      });
      if (rpcError) throw rpcError;
      setEditing(null); setForm(empty()); await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  async function remove(entry: Entry) {
    if (!window.confirm(`Remove ${money(entry.amount_cents)} from ${label(entry.source)}? Its audit history will remain.`)) return;
    setBusy(true); setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_void_withdrawal', { p_id: entry.id, p_source: entry.source });
      if (rpcError) throw rpcError;
      if (editing === entry.id) { setEditing(null); setForm(empty()); }
      await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  function edit(entry: Entry) {
    setEditing(entry.id);
    setForm({
      source: entry.source, amount: (entry.amount_cents / 100).toFixed(2),
      moved_on: entry.moved_on, reason: entry.reason, person_id: entry.person_id || '',
      performed_by: entry.performed_by || '', note: entry.note,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function showAudit(entry: Entry) {
    if (auditFor === entry.id) { setAuditFor(null); return; }
    setError('');
    const { data, error: rpcError } = await client.rpc('portal_withdrawal_audit', { p_source: entry.source, p_id: entry.id });
    if (rpcError) { setError(rpcError.message); return; }
    setAudit((data || []) as Audit[]); setAuditFor(entry.id);
  }

  const visibleSources = SOURCES.filter((source) => balances.some((balance) => balance.source === source.id));
  return <div className="withdrawals-page">
    <header><div><div className="eyebrow">MONEY MOVING</div><h1>Withdrawals</h1>
      <p>Record cash taken from the safe and transfers from each selling account. Withdrawals do not reduce profit.</p></div></header>
    {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>×</button></div>}
    <section className="panel">
      <h2>{editing ? 'Edit withdrawal' : 'Record withdrawal'}</h2>
      <form className="withdrawal-form" onSubmit={(event) => void save(event)}>
        <label>Source<select value={form.source} disabled={!!editing} onChange={(event) => setForm({ ...form, source: event.target.value as Source })}>
          {visibleSources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
        </select></label>
        <label>Amount ($)<input required inputMode="decimal" type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
        <label>Date<input required type="date" value={form.moved_on} onChange={(event) => setForm({ ...form, moved_on: event.target.value })} /></label>
        <label>Reason<select value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value as Reason, person_id: '' })}>
          {REASONS.map((reason) => <option key={reason.id} value={reason.id}>{reason.label}</option>)}
        </select></label>
        <label>Who did it<select value={form.performed_by} onChange={(event) => setForm({ ...form, performed_by: event.target.value })}>
          <option value="">Me · signed in</option>{people.map((person) => <option key={person.user_id} value={person.user_id}>{person.display_name}</option>)}
        </select></label>
        {form.reason === 'person_payout' && <label>Person<select required value={form.person_id} onChange={(event) => setForm({ ...form, person_id: event.target.value })}>
          <option value="">Choose person</option>{people.map((person) => <option key={person.user_id} value={person.user_id}>{person.display_name}</option>)}
        </select></label>}
        <label className="withdrawal-note">Note<input value={form.note} maxLength={500} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="Optional reference or details" /></label>
        <div className="actions"><button disabled={busy}>{editing ? 'Save changes' : 'Record'}</button>
          {editing && <button type="button" className="secondary" onClick={() => { setEditing(null); setForm(empty()); }}>Cancel</button>}</div>
      </form>
      {form.reason === 'person_payout' && <p className="hint">Saving also posts one linked payment to this person’s running payout balance.</p>}
    </section>
    <section className="panel"><h2>Reconciliation · all time</h2>
      <p className="hint">Expected balance uses recorded sales less channel fees, refunds and withdrawals. Opening balances, deposits and unmatched external payouts may need separate review.</p>
      <div className="withdrawal-balance-list">
        {balances.map((row) => <details className="withdrawal-balance" key={row.source}>
          <summary><strong>{label(row.source)}</strong><span>Expected {money(row.expected_cents)}</span></summary>
          <div className="withdrawal-parts"><span>Sales less fees</span><b>{money(row.sales_less_fees_cents)}</b>
            <span>Refunds</span><b>−{money(row.refund_cents)}</b>
            <span>Withdrawn</span><b>−{money(row.withdrawn_cents)}</b></div>
        </details>)}
      </div>
    </section>
    <section className="panel"><h2>History</h2>
      {!loaded ? <p>Loading…</p> : entries.length === 0 ? <p className="empty">No withdrawals recorded yet.</p>
        : <div className="withdrawal-list">{entries.map((entry) => <details key={entry.id} className="withdrawal-entry">
          <summary><span><strong>{label(entry.source)} · {money(entry.amount_cents)}</strong>
            <small>{entry.moved_on} · {reasonLabel(entry.reason)}{entry.voided_at ? ' · Removed' : ''}</small></span><span className="app-chevron">›</span></summary>
          <div className="withdrawal-entry-body">
            {entry.person_id && <p>Paid to {people.find((person) => person.user_id === entry.person_id)?.display_name || entry.person_id}</p>}
            <p>Withdrawn by {people.find((person) => person.user_id === entry.performed_by)?.display_name || 'Unknown'}</p>
            {entry.note && <p>{entry.note}</p>}
            <small>Recorded {stamp(entry.created_at)} by {people.find((person) => person.user_id === entry.created_by)?.display_name || 'Unknown'}
              {entry.updated_at ? ` · Edited ${stamp(entry.updated_at)}` : ''}</small>
            <div className="actions">
              {!entry.voided_at && <><button type="button" className="secondary" disabled={busy} onClick={() => edit(entry)}>Edit</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => void remove(entry)}>Remove</button></>}
              <button type="button" className="secondary" onClick={() => void showAudit(entry)}>Audit trail</button>
            </div>
            {auditFor === entry.id && <div className="withdrawal-audit">{audit.map((revision) => <div key={revision.id}>
              <strong>{revision.action}</strong> · {stamp(revision.at)} · {people.find((person) => person.user_id === revision.actor_id)?.display_name || 'Unknown'}
              {revision.old_row && <small>Previously {money(revision.old_row.amount_cents)} · {revision.old_row.moved_on} · {reasonLabel(revision.old_row.reason)}</small>}
            </div>)}</div>}
          </div>
        </details>)}</div>}
    </section>
  </div>;
}
