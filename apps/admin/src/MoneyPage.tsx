import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ToolSourceBadge } from './design/Tools';
import { floorFunctionUrl } from './floorApi';

// Money tab (admin only; every RPC is admin-checked on the server). Data model: supabase/migrations/20261107100000_money_tab.sql.
type Account = 'safe' | 'square' | 'ebay' | 'ebay_pgg124_5' | 'depop' | 'amazon' | 'tiktok';
type Dir = 'in' | 'out';
type Sync = { status: 'ok' | 'reconnect' | 'not_connected' | 'error'; message: string; synced_at: string; detail: Record<string, number> } | null;
type Overview = { account: Account; sales_cents: number; in_cents: number; out_cents: number; floor_cents: number; balance_cents: number; synced: boolean; sync: Sync };
type Row = {
  kind: 'entry' | 'marker' | 'sales'; id: string; direction: Dir | 'none'; amount_cents: number; reason: string; note: string;
  person_id: string | null; by_user: string | null; at: string; auto: boolean; transfer_id: string | null; label: string | null; week: string | null; n: number | null;
};
type SaleLine = { receipt_no: string | null; at: string; cents: number; sku: string | null };
type Audit = { id: number; action: string; at: string; actor_id: string | null; old_row: { amount_cents?: number; note?: string } | null };
type Person = { id: string; label: string };
type Props = { client: SupabaseClient; storeId: string; accessToken: string; money: (cents: number) => string; stamp: (value: string) => string };

const NAMES: Record<Account, string> = { safe: 'Safe cash', square: 'Square', ebay: 'eBay', ebay_pgg124_5: 'eBay · pgg124-5', depop: 'Depop', amazon: 'Amazon', tiktok: 'TikTok' };
const REASON: Record<string, string> = {
  starting_cash: 'Starting cash', change_for_drawer: 'Change for drawer', moved_from_square: 'Moved from Square', moved_from_safe: 'Moved from Safe',
  owner_put_in: 'Owner put in', count_correction: 'Count correction', owner_draw: 'Owner draw', person_payout: 'Payout', bank_deposit: 'Bank deposit',
  supplies: 'Supplies', move_to_square: 'Move to Square', move_to_safe: 'Move to Safe', other: 'Withdrawal', counted: 'Counted',
};
/** Reason chips per account and direction. Payout chips are added from the Paul / Jacob people settings. */
function chips(account: Account, dir: Dir): string[] {
  if (dir === 'in') {
    if (account === 'safe') return ['starting_cash', 'change_for_drawer', 'moved_from_square', 'owner_put_in', 'count_correction'];
    if (account === 'square') return ['moved_from_safe', 'owner_put_in', 'count_correction'];
    return account === 'depop' ? ['starting_cash', 'owner_put_in', 'count_correction'] : ['owner_put_in', 'count_correction'];
  }
  const base = ['owner_draw', 'PAYOUTS', 'bank_deposit', 'supplies'];
  const move = account === 'safe' ? ['move_to_square'] : account === 'square' ? ['move_to_safe'] : [];
  return [...base, ...move, 'count_correction'];
}
const localInput = (d = new Date()) => { const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const weekLabel = (week: string) => {
  const start = new Date(`${week}T12:00:00`); const now = new Date(); const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return start.toDateString() === new Date(monday.setHours(12, 0, 0, 0)).toDateString() ? 'this week' : `week of ${shortDate(week + 'T12:00:00')}`;
};

async function startConnect(accessToken: string, account: 'ebay' | 'square') {
  const response = account === 'ebay'
    ? await fetch(floorFunctionUrl('ebay-connection'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'connect_selling' }) })
    : await fetch(`${floorFunctionUrl('oauth-start')}?provider=square`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await response.json();
  if (!response.ok || body.ok === false || !body.url) throw new Error(body.message || body.error || 'Could not open the login page.');
  window.location.assign(body.url);
}

export function MoneyPage({ client, storeId, accessToken, money, stamp }: Props) {
  const [overview, setOverview] = useState<Overview[]>([]);
  const [recent, setRecent] = useState<Record<string, Row[]>>({});
  const [people, setPeople] = useState<Person[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [me, setMe] = useState<{ id: string; name: string }>({ id: '', name: 'Me' });
  const [sheet, setSheet] = useState<{ account: Account; dir: Dir; row?: Row } | null>(null);
  const [all, setAll] = useState<{ account: Account; rows: Row[]; total: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connecting, setConnecting] = useState('');

  const load = useCallback(async () => {
    const over = await client.rpc('portal_money_overview');
    if (over.error) throw over.error;
    const accounts = (over.data || []) as Overview[];
    const [people_, staff, user, ...activity] = await Promise.all([
      client.from('store_payout_people').select('slot,employee_id').eq('store_id', storeId),
      client.from('staff').select('user_id,display_name').eq('store_id', storeId),
      client.auth.getUser(),
      ...accounts.map((a) => client.rpc('portal_money_activity', { p_account: a.account, p_limit: 4, p_offset: 0 })),
    ]);
    const nameMap = Object.fromEntries(((staff.data || []) as { user_id: string; display_name: string }[]).map((s) => [s.user_id, s.display_name]));
    setNames(nameMap);
    setPeople(((people_.data || []) as { slot: string; employee_id: string | null }[]).filter((p) => p.employee_id)
      .map((p) => ({ id: p.employee_id as string, label: p.slot === 'paul' ? 'Paul' : p.slot === 'jacob' ? 'Jacob' : nameMap[p.employee_id as string] || p.slot })).sort((a, b) => a.label.localeCompare(b.label)));
    const uid = user.data.user?.id || '';
    setMe({ id: uid, name: nameMap[uid] || 'Me' });
    const next: Record<string, Row[]> = {};
    accounts.forEach((a, i) => { const r = activity[i] as { data: { rows: Row[] } | null; error: { message: string } | null }; if (r.error) throw r.error; next[a.account] = r.data?.rows || []; });
    setOverview(accounts); setRecent(next); setLoaded(true);
  }, [client, storeId]);

  useEffect(() => { void load().catch((e) => setError(String(e.message || e))); }, [load]);

  const total = overview.reduce((sum, a) => sum + a.balance_cents, 0);
  const payeeName = (id: string | null) => people.find((p) => p.id === id)?.label || 'a person';
  const rowTitle = (r: Row) => r.reason === 'person_payout' ? `Payout to ${payeeName(r.person_id)}` : r.auto ? 'Bank payout' : REASON[r.reason] || r.reason;

  async function openAll(account: Account) {
    const { data, error: e } = await client.rpc('portal_money_activity', { p_account: account, p_limit: 50, p_offset: 0 });
    if (e) { setError(e.message); return; }
    setAll({ account, rows: (data as { rows: Row[] }).rows, total: (data as { total: number }).total });
  }
  async function moreAll() {
    if (!all) return;
    const { data, error: e } = await client.rpc('portal_money_activity', { p_account: all.account, p_limit: 50, p_offset: all.rows.length });
    if (e) { setError(e.message); return; }
    setAll({ ...all, rows: [...all.rows, ...(data as { rows: Row[] }).rows] });
  }
  async function reconnect(account: 'ebay' | 'square') {
    setConnecting(account); setError('');
    try { await startConnect(accessToken, account); } catch (e) { setError(String((e as Error).message || e)); setConnecting(''); }
  }
  async function reconnectPersonalEbay() {
    setConnecting('ebay_pgg124_5'); setError('');
    try {
      const response = await fetch(floorFunctionUrl('ebay-connection'), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'connect_orders_only' }) });
      const body = await response.json();
      if (!response.ok || body.ok === false || !body.url) throw new Error(body.message || body.error || 'Could not open the eBay authorization page.');
      window.location.assign(body.url);
    } catch (e) { setError(String((e as Error).message || e)); setConnecting(''); }
  }
  const done = async (message: string) => { setSheet(null); setNotice(message); await load(); if (all) await openAll(all.account); };

  const rowsView = (account: Account, rows: Row[]) => rows.map((r) => <ActivityLine key={r.id} row={r} account={account} title={rowTitle(r)} money={money} stamp={stamp}
    who={r.by_user ? names[r.by_user] || '' : ''} client={client} onOpen={() => setSheet({ account, dir: r.direction === 'in' ? 'in' : 'out', row: r })} setError={setError} />);

  return <div className="money-page">
    <header className="money-head"><h1>Money</h1><div className="money-total-label">All accounts</div>
      <div className="money-total">{loaded ? money(total) : '—'}</div></header>
    {error && <div className="alert" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {!loaded && !error && <p role="status">Loading money…</p>}
    <div className="money-cards">
      {overview.map((a) => {
        const detail = a.sync?.detail || {};
        const personalEbay = a.account === 'ebay_pgg124_5';
        return <section className="money-card" key={a.account} aria-label={NAMES[a.account]}>
          <div className="money-card-top"><ToolSourceBadge source={a.account} /><strong className="money-name">{NAMES[a.account]}</strong><span className="money-balance">{money(a.balance_cents)}</span></div>
          {(a.account === 'ebay' || personalEbay || a.account === 'square' || a.account === 'amazon' || a.account === 'tiktok') && <p className="money-sync">
            {a.synced
              ? <>Synced · {stamp(a.sync!.synced_at)}{(a.account === 'ebay' || personalEbay) && detail.available_cents != null ? ` · Available ${money(detail.available_cents)} · Processing ${money(detail.processing_cents || 0)} · On hold ${money(detail.on_hold_cents || 0)}` : ''}</>
              : a.sync?.status === 'reconnect' || a.sync?.status === 'not_connected' || !a.sync
                ? <>{a.sync?.message || (a.account === 'ebay' || personalEbay || a.account === 'square' ? 'Not synced yet.' : 'Manual')}{personalEbay ? <> <button type="button" className="money-link" disabled={connecting === a.account} onClick={() => void reconnectPersonalEbay()}>{connecting === a.account ? 'Opening…' : 'Reconnect pgg124-5'}</button></> : (a.account === 'ebay' || a.account === 'square') && <> <button type="button" className="money-link" disabled={connecting === a.account} onClick={() => void reconnect(a.account as 'ebay' | 'square')}>{connecting === a.account ? 'Opening…' : a.sync?.status === 'not_connected' ? `Connect ${NAMES[a.account]}` : `Reconnect ${NAMES[a.account]}`}</button></>}</>
                : <>Sync problem: {a.sync.message}</>}
          </p>}
          {!personalEbay && <><div className="money-buttons">
            <button type="button" className="money-add" onClick={() => setSheet({ account: a.account, dir: 'in' })}>+ Add money</button>
            <button type="button" className="money-take" onClick={() => setSheet({ account: a.account, dir: 'out' })}>− Take out</button>
          </div>
          <div className="money-activity">{(recent[a.account] || []).length ? rowsView(a.account, recent[a.account]) : <p className="empty">No activity yet.</p>}</div>
          <button type="button" className="money-link money-all" onClick={() => void openAll(a.account)}>See all activity</button></>}
        </section>;
      })}
    </div>
    {all && <div className="money-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setAll(null); }}>
      <section className="money-sheet" role="dialog" aria-modal="true" aria-label={`${NAMES[all.account]} activity`}>
        <div className="money-sheet-head"><h2>{NAMES[all.account]} activity</h2><button type="button" className="money-x" aria-label="Close" onClick={() => setAll(null)}>×</button></div>
        <div className="money-activity money-activity-all">{rowsView(all.account, all.rows)}</div>
        {all.rows.length < all.total && <button type="button" className="secondary" onClick={() => void moreAll()}>Show more</button>}
      </section></div>}
    {sheet && <MoneySheet key={`${sheet.account}${sheet.dir}${sheet.row?.id || 'new'}`} client={client} sheet={sheet} overview={overview.find((o) => o.account === sheet.account)!}
      people={people} meName={me.name} meId={me.id} money={money} stamp={stamp} names={names} onClose={() => setSheet(null)} onDone={done} />}
  </div>;
}

function ActivityLine({ row, account, title, who, money, stamp, client, onOpen, setError }: { row: Row; account: Account; title: string; who: string; money: (c: number) => string;
  stamp: (v: string) => string; client: SupabaseClient; onOpen: () => void; setError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<SaleLine[] | null>(null);
  if (row.kind === 'marker') return <div className="money-line money-marker"><div><span className="money-line-title">Counted {money(row.amount_cents)}</span>
    <small>{shortDate(row.at)}{row.note ? ` · ${row.note}` : ''} · note only, balance unchanged</small></div></div>;
  const green = row.direction === 'in';
  if (row.kind === 'sales') {
    const toggle = async () => {
      setOpen(!open);
      if (!lines && row.week) {
        const { data, error: e } = await client.rpc('portal_money_sales', { p_account: account, p_week: row.week });
        if (e) setError(e.message); else setLines((data || []) as SaleLine[]);
      }
    };
    return <div className="money-line-wrap"><button type="button" className="money-line money-sales" onClick={() => void toggle()} aria-expanded={open}>
      <div><span className="money-line-title">{row.label} · {weekLabel(row.week || row.at)}</span><small>{row.n ? `${row.n} sale${row.n === 1 ? '' : 's'}` : 'adjustment'}</small></div>
      <b className={green ? 'money-in' : 'money-out'}>{green ? '+' : '−'}{money(Math.abs(row.amount_cents))}</b></button>
      {open && <div className="money-sale-lines">{lines === null ? <small>Loading…</small> : lines.length === 0 ? <small>No individual sales.</small> : lines.map((l, i) => <div key={i}><span>{shortDate(l.at)} · {l.receipt_no || l.sku || 'sale'}</span><span>{money(l.cents)}</span></div>)}</div>}
    </div>;
  }
  return <button type="button" className="money-line" onClick={onOpen}>
    <div><span className="money-line-title">{title}{row.auto && <em className="money-auto">Auto</em>}</span>
      <small>{shortDate(row.at)}{who ? ` · ${who}` : ''}{row.note ? ` · “${row.note}”` : ''}{row.transfer_id ? ' · transfer' : ''}</small></div>
    <b className={green ? 'money-in' : 'money-out'}>{green ? '+' : '−'}{money(row.amount_cents)}</b></button>;
}

function MoneySheet({ client, sheet, overview, people, meName, meId, money, stamp, names, onClose, onDone }: { client: SupabaseClient; sheet: { account: Account; dir: Dir; row?: Row };
  overview: Overview; people: Person[]; meName: string; meId: string; money: (c: number) => string; stamp: (v: string) => string; names: Record<string, string>;
  onClose: () => void; onDone: (message: string) => Promise<void> }) {
  const editing = sheet.row;
  const [dir, setDir] = useState<Dir>(sheet.dir);
  const [amount, setAmount] = useState(editing ? (editing.amount_cents / 100).toFixed(2) : '');
  const [reason, setReason] = useState(editing ? (editing.reason === 'other' ? '' : editing.reason) : '');
  const [payee, setPayee] = useState(editing?.reason === 'person_payout' ? editing.person_id || '' : '');
  const [note, setNote] = useState(editing?.note || '');
  const [at, setAt] = useState(localInput(editing ? new Date(editing.at) : new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<Audit[] | null>(null);
  const submitting = useRef(false);
  const auto = Boolean(editing?.auto);
  const cents = Math.round(Number(amount) * 100);
  const valid = Number.isFinite(cents) && cents > 0 && Math.abs(Number(amount) * 100 - cents) < 0.001;
  const key = reason === 'person_payout' ? `payout:${payee}` : reason;
  const delta = valid ? (dir === 'in' ? cents : -cents) - (editing ? (editing.direction === 'in' ? editing.amount_cents : -editing.amount_cents) : 0) : 0;
  const after = overview.balance_cents + delta;
  const available = chips(sheet.account, dir).flatMap((c) => c === 'PAYOUTS' ? people.map((p) => ({ key: `payout:${p.id}`, label: `Payout to ${p.label}` })) : [{ key: c, label: REASON[c] }]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    if (!valid) { setError('Enter an amount with no more than two decimals.'); return; }
    if (!reason) { setError('Choose a reason.'); return; }
    if (reason === 'person_payout' && !payee) { setError('Choose who the payout was to.'); return; }
    submitting.current = true; setBusy(true); setError('');
    try {
      const { error: e } = await client.rpc('portal_money_save', { p_id: editing?.id ?? null, p_account: sheet.account, p_direction: dir, p_amount_cents: cents, p_reason: reason,
        p_note: note.trim(), p_at: new Date(at).toISOString(), p_person: reason === 'person_payout' ? payee : null, p_performer: editing?.by_user ?? null });
      if (e) throw e;
      await onDone(reason === 'person_payout' ? 'Saved. The payout was also recorded in Payouts.' : editing ? 'Saved.' : dir === 'in' ? 'Money added.' : 'Taken out.');
    } catch (err) { setError(String((err as Error).message || err)); submitting.current = false; setBusy(false); }
  }
  async function remove() {
    if (!editing || submitting.current) return;
    if (!window.confirm(`Delete this ${money(editing.amount_cents)} entry?${editing.reason === 'person_payout' ? ' Its payment in Payouts is removed too.' : ''}${editing.transfer_id ? ' The other side of the transfer is removed too.' : ''} Its history is kept.`)) return;
    submitting.current = true; setBusy(true); setError('');
    try { const { error: e } = await client.rpc('portal_money_delete', { p_id: editing.id }); if (e) throw e; await onDone('Deleted.'); }
    catch (err) { setError(String((err as Error).message || err)); submitting.current = false; setBusy(false); }
  }
  async function showHistory() {
    if (!editing) return;
    if (history) { setHistory(null); return; }
    const { data, error: e } = await client.rpc('portal_money_history', { p_id: editing.id });
    if (e) setError(e.message); else setHistory((data || []) as Audit[]);
  }

  return <div className="money-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <form className="money-sheet money-move" role="dialog" aria-modal="true" aria-label={`${NAMES[sheet.account]} ${dir === 'in' ? 'add money' : 'take out'}`} onSubmit={(e) => void save(e)}>
      <div className="money-grab" aria-hidden="true" />
      <div className="money-sheet-head"><h2>{NAMES[sheet.account]}</h2><button type="button" className="money-x" aria-label="Close" onClick={onClose}>×</button></div>
      <div className="money-toggle" role="group" aria-label="Direction">
        <button type="button" className={dir === 'in' ? 'on in' : ''} disabled={Boolean(editing) || busy} onClick={() => { setDir('in'); setReason(''); setPayee(''); }}>+ Add money</button>
        <button type="button" className={dir === 'out' ? 'on out' : ''} disabled={Boolean(editing) || busy} onClick={() => { setDir('out'); setReason(''); setPayee(''); }}>− Take out</button>
      </div>
      <label className="money-amount-label">Amount
        <div className={`money-amount ${dir}`}><span>$</span><input inputMode="decimal" type="number" min="0.01" step="0.01" placeholder="0.00" autoFocus disabled={busy || auto} value={amount} onChange={(e) => setAmount(e.target.value)} /></div></label>
      <div className="money-after">{NAMES[sheet.account]} after: {valid ? money(after) : money(overview.balance_cents)}{overview.synced ? ' (balance comes from the platform; this entry is recorded in Floor’s own number)' : ''}</div>
      <div className="money-reason-label">Reason</div>
      <div className="money-chips" role="radiogroup" aria-label="Reason">
        {available.map((c) => <button type="button" role="radio" aria-checked={key === c.key} key={c.key} className={key === c.key ? 'on' : ''} disabled={busy || auto}
          onClick={() => { if (c.key.startsWith('payout:')) { setReason('person_payout'); setPayee(c.key.slice(7)); } else { setReason(c.key); setPayee(''); } }}>{c.label}</button>)}
        {editing && reason === '' && <span className="money-chip-note">Older entry (“{REASON[editing.reason] || editing.reason}”): choose a reason to change it.</span>}
      </div>
      <label>Note (optional)<input value={note} maxLength={500} disabled={busy} placeholder="What was it for?" onChange={(e) => setNote(e.target.value)} /></label>
      <div className="money-meta"><span>By: {editing?.by_user ? names[editing.by_user] || '—' : meName}</span>
        <label className="money-when">When<input type="datetime-local" value={at} disabled={busy || auto} onChange={(e) => setAt(e.target.value)} /></label></div>
      {error && <p className="alert" role="alert">{error}</p>}
      {auto ? <p className="hint">This is an Auto bank payout from {NAMES[sheet.account]}. You can delete it; it will not come back.</p>
        : <button className={`money-go ${dir}`} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : dir === 'in' ? `Add ${valid ? money(cents) : ''}` : `Take out ${valid ? money(cents) : ''}`}</button>}
      {editing && <div className="money-edit-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void remove()}>Delete</button>
        <button type="button" className="secondary" onClick={() => void showHistory()}>History</button></div>}
      {history && <div className="money-history">{history.length === 0 ? <small>No history.</small> : history.map((h) => <div key={h.id}><strong>{h.action}</strong> · {stamp(h.at)}{h.actor_id && h.actor_id !== meId ? ` · ${names[h.actor_id] || ''}` : ''}{h.old_row?.amount_cents != null ? <small> was {money(h.old_row.amount_cents)}</small> : null}</div>)}</div>}
    </form></div>;
}
