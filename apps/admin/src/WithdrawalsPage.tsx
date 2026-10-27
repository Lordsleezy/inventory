import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ToolCard, ToolIcon, ToolSourceBadge } from './design/Tools';
import type { SupabaseClient } from '@supabase/supabase-js';

type Source = 'safe' | 'square' | 'ebay' | 'amazon' | 'tiktok' | 'depop';
type Reason = 'bank_deposit' | 'person_payout' | 'owner_draw' | 'other';
type Entry = {
  id: string; source: Source; amount_cents: number; moved_on: string;
  reason: Reason; note: string; person_id: string | null;
  performed_by: string | null;
  created_by: string | null; created_at: string; updated_by: string | null;
  updated_at: string | null; voided_at: string | null;
  external_id?: string | null; external_status?: string | null;
};
type Balance = {
  source: Source; sales_less_fees_cents: number; refund_cents: number;
  withdrawn_cents: number; expected_cents: number;
};
type Counted = { id: string; source: Source; actual_cents: number; adjusted_on: string; note: string };
type Payee = { id: string; label: string };
type Audit = { id: number; action: string; at: string; actor_id: string | null; old_row: Entry | null; new_row: Entry | null };
type Props = { client: SupabaseClient; storeId: string; money: (cents: number) => string; stamp: (value: string) => string };

const SOURCES: { id: Source; label: string }[] = [
  { id: 'safe', label: 'Safe cash' }, { id: 'square', label: 'Square' },
  { id: 'ebay', label: 'eBay' }, { id: 'amazon', label: 'Amazon' },
  { id: 'tiktok', label: 'TikTok' }, { id: 'depop', label: 'Depop' },
];
const NOT_COUNTED = ['FAILED', 'RETRYABLE_FAILED', 'REVERSED'];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const blank = () => ({ amount: '', moved_on: today(), note: '', payee: '' });

export function WithdrawalsPage({ client, storeId, money, stamp }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [counted, setCounted] = useState<Counted[]>([]);
  const [payees, setPayees] = useState<Payee[]>([]);
  const [formFor, setFormFor] = useState<Source | null>(null);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [form, setForm] = useState(blank);
  const [countFor, setCountFor] = useState<Source | null>(null);
  const [countAmount, setCountAmount] = useState('');
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const submitting = useRef(false);

  const load = useCallback(async () => {
    const [entryResult, balanceResult, peopleResult, staffResult, countedResult] = await Promise.all([
      client.rpc('portal_withdrawal_entries', { p_limit: 1000 }),
      client.rpc('portal_withdrawal_reconciliation'),
      client.from('store_payout_people').select('slot,employee_id').eq('store_id', storeId),
      client.from('staff').select('user_id,display_name').eq('store_id', storeId),
      client.rpc('portal_withdrawal_balance_adjustments'),
    ]);
    for (const result of [entryResult, balanceResult, peopleResult, staffResult, countedResult]) if (result.error) throw result.error;
    setEntries((entryResult.data || []) as Entry[]);
    setBalances((balanceResult.data || []) as Balance[]);
    setCounted((countedResult.data || []) as Counted[]);
    const names = new Map(((staffResult.data || []) as { user_id: string; display_name: string }[]).map((s) => [s.user_id, s.display_name]));
    setPayees(((peopleResult.data || []) as { slot: string; employee_id: string | null }[])
      .filter((p) => p.employee_id).map((p) => ({ id: p.employee_id as string, label: p.slot === 'paul' ? 'Paul' : p.slot === 'jacob' ? 'Jacob' : names.get(p.employee_id as string) || p.slot }))
      .sort((a, b) => a.label.localeCompare(b.label)));
    setLoaded(true);
  }, [client, storeId]);

  useEffect(() => { void load().catch((e) => setError(String(e.message || e))); }, [load]);

  const payeeName = (id: string | null) => payees.find((p) => p.id === id)?.label || 'a person';
  const counts = (e: Entry) => !e.voided_at && !NOT_COUNTED.includes(e.external_status || '');

  function openAdd(source: Source) {
    setFormFor(source); setEditing(null); setForm(blank()); setError(''); setNotice('');
  }
  function openEdit(entry: Entry) {
    setFormFor(entry.source); setEditing(entry); setError(''); setNotice('');
    setForm({ amount: (entry.amount_cents / 100).toFixed(2), moved_on: entry.moved_on, note: entry.note, payee: entry.reason === 'person_payout' ? entry.person_id || '' : '' });
  }
  function closeForm() { setFormFor(null); setEditing(null); setForm(blank()); }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || !formFor) return;
    const amount = Number(form.amount); const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || cents <= 0 || Math.abs(amount * 100 - cents) > 0.001) { setError('Enter a positive amount with no more than two decimal places.'); return; }
    if (!editing && !form.note.trim()) { setError('Add a note: what was this withdrawal for?'); return; }
    submitting.current = true; setBusy(true); setError('');
    try {
      const payout = Boolean(form.payee);
      // Keep an imported payout's reason (bank deposit) unless it is now marked as a payout to a person.
      const reason: Reason = payout ? 'person_payout' : editing && editing.reason !== 'person_payout' ? editing.reason : 'other';
      const { error: rpcError } = await client.rpc('portal_save_withdrawal', {
        p_id: editing?.id ?? null, p_source: formFor, p_amount_cents: cents, p_on: form.moved_on, p_reason: reason,
        p_note: form.note.trim(), p_person: payout ? form.payee : null, p_performer: editing?.performed_by ?? null,
      });
      if (rpcError) throw rpcError;
      closeForm(); setNotice(payout ? 'Saved. The payout was also recorded in Payouts.' : 'Withdrawal saved.'); await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function remove(entry: Entry) {
    if (busy || submitting.current) return;
    const linked = entry.reason === 'person_payout' ? ' Its payment in Payouts is removed too.' : '';
    if (!window.confirm(`Delete the ${money(entry.amount_cents)} withdrawal from ${entry.moved_on}?${linked} Its history is kept.`)) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_void_withdrawal', { p_id: entry.id, p_source: entry.source });
      if (rpcError) throw rpcError;
      if (editing?.id === entry.id) closeForm();
      await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function showAudit(entry: Entry) {
    if (auditFor === entry.id) { setAuditFor(null); return; }
    const { data, error: rpcError } = await client.rpc('portal_withdrawal_audit', { p_source: entry.source, p_id: entry.id });
    if (rpcError) { setError(rpcError.message); return; }
    setAudit((data || []) as Audit[]); setAuditFor(entry.id);
  }

  /** Optional "counted" check: a note of what was physically/online counted. It never changes the math. */
  async function saveCounted(event: FormEvent) {
    event.preventDefault(); if (!countFor || busy) return;
    const amount = Number(countAmount); const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || cents < 0 || Math.abs(amount * 100 - cents) > 0.001) { setError('Enter the counted amount.'); return; }
    setBusy(true); setError('');
    try {
      const { error: rpcError } = await client.rpc('portal_save_withdrawal_balance_adjustment', { p_source: countFor, p_actual_cents: cents, p_on: today(), p_note: 'Counted' });
      if (rpcError) throw rpcError;
      setCountFor(null); setCountAmount(''); await load();
    } catch (e) { setError(String((e as Error).message || e)); }
    finally { setBusy(false); }
  }

  const visible = SOURCES.filter((source) => balances.some((balance) => balance.source === source.id));
  const totalExpected = balances.reduce((sum, row) => sum + row.expected_cents, 0);
  return <div className="floor-tools withdrawals-page">
    <header><div><h1>Withdrawals</h1><p>Every withdrawal, by source. Expected balance = sales less fees − refunds − withdrawn.</p></div>
      <span className="tool-all-time"><ToolIcon name="calendar"/>All time</span></header>
    {error && <div className="alert" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!loaded && <p role="status">{error ? 'Could not load records.' : 'Loading withdrawals…'} {error && <button type="button" className="secondary" onClick={() => void load().catch(e => setError(String(e.message || e)))}>Retry</button>}</p>}
    <ToolCard className="withdrawal-expected"><span className="tool-icon-badge"><ToolIcon name="bank"/></span><div>
      <span className="expected-caption">Expected total balance</span><strong className="expected-amount">{loaded ? money(totalExpected) : '—'}</strong>
      <p>Opening balances and deposits are not in this number. eBay and Square payouts to the bank are imported automatically as withdrawals.</p>
    </div></ToolCard>
    <div className="withdrawal-source-head"><h2>By source</h2><span>Expected balance</span></div>
    <div className="withdrawal-balance-list">
      {visible.map((source) => {
        const row = balances.find((b) => b.source === source.id)!;
        const list = entries.filter((e) => e.source === source.id && !e.voided_at);
        const check = counted.find((c) => c.source === source.id);
        return <details className="withdrawal-balance" key={source.id} open={formFor === source.id || undefined}>
          <summary><span className="tool-source-name"><ToolSourceBadge source={source.id}/><strong>{source.label}</strong></span>
            <span className="tool-source-balance"><small>Expected</small><strong>{money(row.expected_cents)}</strong></span><span aria-hidden="true">›</span></summary>
          <div className="withdrawal-parts"><span>Sales less fees</span><b>{money(row.sales_less_fees_cents)}</b><span>Refunds</span><b>−{money(row.refund_cents)}</b>
            <span>Withdrawn ({list.filter(counts).length})</span><b>−{money(row.withdrawn_cents)}</b></div>
          <div className="actions"><button type="button" className="tool-primary" disabled={busy} onClick={() => openAdd(source.id)}><ToolIcon name="plus"/>+ Add withdrawal</button></div>
          {formFor === source.id && <form className="withdrawal-form withdrawal-inline" onSubmit={(event) => void save(event)}>
            <label>Date<input required type="date" disabled={busy} value={form.moved_on} onChange={(event) => setForm({ ...form, moved_on: event.target.value })} /></label>
            <label>Amount ($)<input required inputMode="decimal" type="number" min="0.01" step="0.01" placeholder="0.00" disabled={busy} value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} /></label>
            <label className="withdrawal-note">What was it for?<input disabled={busy} maxLength={500} value={form.note} placeholder="e.g. Deposited at the bank" onChange={(event) => setForm({ ...form, note: event.target.value })} /></label>
            {payees.length > 0 && <label>This was a payout to<select disabled={busy} value={form.payee} onChange={(event) => setForm({ ...form, payee: event.target.value })}>
              <option value="">Not a payout</option>{payees.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>}
            <div className="actions"><button className="tool-primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save withdrawal'}</button>
              <button type="button" className="secondary" disabled={busy} onClick={closeForm}>Cancel</button></div>
            {form.payee && <p className="hint">Saving also records one payment to {payeeName(form.payee)} in Payouts. Editing or deleting this withdrawal updates it.</p>}
          </form>}
          {list.length === 0 ? <p className="empty">No withdrawals yet.</p> : <div className="withdrawal-list">{list.map((entry) => {
            const bad = NOT_COUNTED.includes(entry.external_status || '');
            return <div key={entry.id} className="withdrawal-entry withdrawal-line">
              <div className="withdrawal-line-main"><strong>{money(entry.amount_cents)}</strong><span>{entry.moved_on}</span>
                <span className="withdrawal-line-note">{entry.note || (entry.reason === 'bank_deposit' ? 'Bank deposit' : '—')}</span></div>
              <div className="withdrawal-line-tags">
                {entry.reason === 'person_payout' && <span className="tag on">Payout to {payeeName(entry.person_id)}</span>}
                {entry.external_id && <span className="tag">{source.label} payout {entry.external_id}{entry.external_status ? ` · ${entry.external_status.toLowerCase()}` : ''}</span>}
                {bad && <span className="tag off">Not counted</span>}
              </div>
              <div className="actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => openEdit(entry)}>Edit</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => void remove(entry)}>Delete</button>
                <button type="button" className="secondary" onClick={() => void showAudit(entry)}>History</button>
              </div>
              {auditFor === entry.id && <div className="withdrawal-audit">{audit.map((revision) => <div key={revision.id}>
                <strong>{revision.action}</strong> · {stamp(revision.at)}
                {revision.old_row && <small> Previously {money(revision.old_row.amount_cents)} · {revision.old_row.moved_on}</small>}
              </div>)}</div>}
            </div>;
          })}</div>}
          <div className="withdrawal-counted">
            {check && <small>Counted {money(check.actual_cents)} on {check.adjusted_on} · {check.actual_cents - row.expected_cents === 0 ? 'matches' : `${money(check.actual_cents - row.expected_cents)} off`} (does not change the balance)</small>}
            {countFor === source.id
              ? <form onSubmit={(event) => void saveCounted(event)}><label>Counted ($)<input required type="number" min="0" step="0.01" value={countAmount} onChange={(event) => setCountAmount(event.target.value)} /></label><button type="submit" className="secondary" disabled={busy}>Save</button><button type="button" className="secondary" onClick={() => setCountFor(null)}>Cancel</button></form>
              : <button type="button" className="link-button" onClick={() => { setCountFor(source.id); setCountAmount(''); }}>Optional: record a counted amount</button>}
          </div>
        </details>;
      })}
    </div>
  </div>;
}
