import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ToolCard, ToolHeading, ToolIcon, ToolSourceBadge } from './design/Tools';
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
  { id: 'safe', label: 'Safe cash' }, { id: 'square', label: 'Square' },
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
  const [formOpen, setFormOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const submitting = useRef(false);
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
    if (submitting.current) return;
    const amount = Number(form.amount);
    const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || cents <= 0 || Math.abs(amount * 100 - cents) > 0.001) {
      setError('Enter a positive amount with no more than two decimal places.'); return;
    }
    if (form.reason === 'person_payout' && !form.person_id) {
      setError('Choose the person receiving this payout.'); return;
    }
    submitting.current = true; setBusy(true); setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_save_withdrawal', {
        p_id: editing, p_source: form.source, p_amount_cents: cents, p_on: form.moved_on,
        p_reason: form.reason, p_note: form.note, p_person: form.reason === 'person_payout' ? form.person_id : null,
        p_performer: form.performed_by || null,
      });
      if (rpcError) throw rpcError;
      setEditing(null); setForm(empty()); setFormOpen(false); setNotice('Withdrawal saved. Expected balances updated.'); await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function remove(entry: Entry) {
    if (busy || submitting.current) return;
    if (!window.confirm(`Remove ${money(entry.amount_cents)} from ${label(entry.source)}? Its audit history will remain.`)) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_void_withdrawal', { p_id: entry.id, p_source: entry.source });
      if (rpcError) throw rpcError;
      if (editing === entry.id) { setEditing(null); setForm(empty()); }
      await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { submitting.current = false; setBusy(false); }
  }

  function edit(entry: Entry) {
    setFormOpen(true); setNotice(''); setError('');
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
  const totalExpected = balances.reduce((sum, row) => sum + row.expected_cents, 0);
  return <div className="floor-tools withdrawals-page">
    {formOpen && <button type="button" className="tool-back" disabled={busy} onClick={() => { setFormOpen(false); setEditing(null); setForm(empty()); setError(''); }}>‹ Withdrawals</button>}
    <header><div><h1>{formOpen ? editing ? 'Edit withdrawal' : 'Record withdrawal' : 'Withdrawals'}</h1>
      <p>{formOpen ? 'Keep your records up to date and track your expected balance.' : 'Reconciliation · all time'}</p></div>
      {!formOpen && <span className="tool-all-time"><ToolIcon name="calendar"/>All time</span>}
    </header>
    {error && <div className="alert" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!loaded && <p role="status">{error ? 'Could not load records.' : 'Loading withdrawal records…'} {error && <button type="button" className="secondary" onClick={() => void load().catch(e => setError(String(e.message || e)))}>Retry</button>}</p>}
    {formOpen ? <ToolCard>
      <form className="withdrawal-form" onSubmit={(event) => void save(event)}>
        <div className="withdrawal-field-icon"><span className="tool-icon-badge"><ToolIcon name="bank"/></span><label>Source<select value={form.source} disabled={!!editing || busy} onChange={(event) => setForm({ ...form, source: event.target.value as Source })}>
          {visibleSources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}
        </select></label></div>
        <div className="withdrawal-field-icon"><span className="tool-icon-badge"><ToolIcon name="money"/></span><label>Amount ($)<input required disabled={busy} inputMode="decimal" type="number" min="0.01" step="0.01" placeholder="0.00" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label></div>
        <div className="withdrawal-field-icon"><span className="tool-icon-badge"><ToolIcon name="calendar"/></span><label>Date<input required disabled={busy} type="date" value={form.moved_on} onChange={(event) => setForm({ ...form, moved_on: event.target.value })} /></label></div>
        <div className="withdrawal-field-icon"><span className="tool-icon-badge"><ToolIcon name="file"/></span><label>Reason<select disabled={busy} value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value as Reason, person_id: '' })}>
          {REASONS.map((reason) => <option key={reason.id} value={reason.id}>{reason.label}</option>)}
        </select></label></div>
        <div className="withdrawal-field-icon"><span className="tool-icon-badge"><ToolIcon name="person"/></span><label>Who did it<select disabled={busy} value={form.performed_by} onChange={(event) => setForm({ ...form, performed_by: event.target.value })}>
          <option value="">Me · signed in</option>{people.map((person) => <option key={person.user_id} value={person.user_id}>{person.display_name}</option>)}
        </select></label></div>
        {form.reason === 'person_payout' && <div className="withdrawal-field-icon"><span className="tool-icon-badge"><ToolIcon name="person"/></span><label>Person receiving payout<select disabled={busy} required value={form.person_id} onChange={(event) => setForm({ ...form, person_id: event.target.value })}>
          <option value="">Choose person</option>{people.map((person) => <option key={person.user_id} value={person.user_id}>{person.display_name}</option>)}
        </select></label></div>}
        <div className="withdrawal-field-icon withdrawal-note"><span className="tool-icon-badge"><ToolIcon name="file"/></span><label>Note (optional)<input disabled={busy} value={form.note} maxLength={500} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="Add a note or reference…" /></label></div>
        <div className="actions"><button className="tool-primary" disabled={busy || !loaded}><ToolIcon name="plus"/>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save withdrawal'}</button></div>
      </form>
      {form.reason === 'person_payout' && <p className="hint">Saving also posts one linked payment to this person’s running payout balance.</p>}
    </ToolCard> : <>
    <ToolCard className="withdrawal-expected"><span className="tool-icon-badge"><ToolIcon name="bank"/></span><div>
      <span className="expected-caption">Expected total balance</span><strong className="expected-amount">{loaded ? money(totalExpected) : '—'}</strong>
      <p>Expected balance uses recorded sales less channel fees, refunds and withdrawals. Opening balances, deposits and unmatched external payouts may need separate review.</p>
    </div></ToolCard>
    <div className="withdrawal-overview-action"><button type="button" className="tool-primary" disabled={!loaded || busy} onClick={() => { setEditing(null); setForm(empty()); setNotice(''); setError(''); setFormOpen(true); }}><ToolIcon name="plus"/>Record withdrawal</button></div>
    <div className="withdrawal-source-head"><h2>By source</h2><span>Expected balance</span></div>
    <div className="withdrawal-balance-list">
      {SOURCES.map(source => { const row = balances.find(b => b.source === source.id); return <details className="withdrawal-balance" key={source.id}>
        <summary><span className="tool-source-name"><ToolSourceBadge source={source.id}/><strong>{source.label}</strong></span><span className="tool-source-balance"><small>Expected</small><strong>{row ? money(row.expected_cents) : '—'}</strong></span><span aria-hidden="true">›</span></summary>
        {row ? <div className="withdrawal-parts"><span>Sales less fees</span><b>{money(row.sales_less_fees_cents)}</b><span>Refunds</span><b>−{money(row.refund_cents)}</b><span>Withdrawn</span><b>−{money(row.withdrawn_cents)}</b></div> : <p>Balance not available.</p>}
      </details>; })}
    </div>
    <section className="panel tool-card"><ToolHeading icon="file" title="Withdrawal history" description="Recorded withdrawals and their audit trail." />
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
    </>}
  </div>;
}
