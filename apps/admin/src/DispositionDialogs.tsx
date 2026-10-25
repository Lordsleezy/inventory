import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { costLabel, parseDollars, type Disposition, type DispositionKind, type SaleHit } from './dispositions';

type Money = (n: number) => string;
type Stamp = (s: string) => string;

/** Replacement + Given away buttons for one in-stock unit. Render only for admins; the server rejects everyone else. */
export function DispositionButtons({ client, sku, money, stamp, onDone, className }: {
  client: SupabaseClient; sku: string; money: Money; stamp: Stamp; onDone: () => void; className?: string;
}) {
  const [open, setOpen] = useState<DispositionKind | null>(null);
  return <>
    <button type="button" className={className} onClick={() => setOpen('replacement')}>Replacement</button>
    <button type="button" className={className} onClick={() => setOpen('giveaway')}>Given away</button>
    {open === 'replacement' && <ReplacementDialog client={client} sku={sku} money={money} stamp={stamp} onClose={() => setOpen(null)} onDone={() => { setOpen(null); onDone(); }} />}
    {open === 'giveaway' && <GiveawayDialog client={client} sku={sku} onClose={() => setOpen(null)} onDone={() => { setOpen(null); onDone(); }} />}
  </>;
}

function ReplacementDialog({ client, sku, money, stamp, onClose, onDone }: {
  client: SupabaseClient; sku: string; money: Money; stamp: Stamp; onClose: () => void; onDone: () => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SaleHit[] | null>(null);
  const [sale, setSale] = useState<SaleHit | null>(null);
  const [bad, setBad] = useState<'yes' | 'not_now' | ''>('');
  const [extra, setExtra] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ cost_missing: boolean; bad_unit_sku: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void Promise.resolve(client.rpc('portal_replacement_sale_search', { p_query: query })).then(({ data, error: e }) => {
        if (!alive) return;
        if (e) setError(e.message); else { setError(''); setHits((data || []) as SaleHit[]); }
      });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [client, query]);

  const extraCents = parseDollars(extra);
  async function record() {
    if (!sale || !bad || extraCents == null) return;
    setBusy(true); setError('');
    try {
      const { data, error: e } = await client.rpc('portal_record_replacement', {
        p_sku: sku, p_sale_id: sale.sale_id, p_bad_unit_returned: bad === 'yes', p_extra_cost_cents: extraCents, p_note: note.trim() || null,
      });
      if (e) throw e;
      setResult(data as { cost_missing: boolean; bad_unit_sku: string | null });
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }

  return <div className="mboard-modal" role="dialog" aria-modal="true" aria-label="Replacement"><div className="mboard-modal-card">
    <h2>Replacement · SKU {sku}</h2>
    {error && <div className="alert" role="alert">{error}</div>}
    {result ? <>
      <p>Recorded. SKU {sku} left stock and is being delisted everywhere. It is not a sale: no revenue, no sales tax.</p>
      {result.bad_unit_sku && <p>The bad unit is in Defective as SKU {result.bad_unit_sku}.</p>}
      {result.cost_missing && <p className="hint">This unit has no cost entered yet, so that sale&apos;s payout waits until you enter one.</p>}
      <div className="actions"><button type="button" onClick={onDone}>Done</button></div>
    </> : !sale ? <>
      <p className="hint">Which sale does this replace? Search by SKU, sale #, or the eBay / Amazon / TikTok / website / Depop order #.</p>
      <label>Find the sale<input autoFocus type="search" value={query} placeholder="SKU, sale #, order #" onChange={e => setQuery(e.target.value)} /></label>
      <div className="ticket-list">
        {hits === null ? <p className="hint">Loading…</p> : hits.length === 0 ? <div className="empty">No sale matches.</div> : hits.map(h => <button type="button" className="ticket" key={h.sale_id} onClick={() => setSale(h)} style={{ textAlign: 'left' }}>
          <div className="ticket-top"><strong>{h.item}</strong><span>{money(h.price_cents)}</span></div>
          <small>Sale #{h.receipt_no} · SKU {h.sku} · {h.channel} · {stamp(h.sold_at)}{h.order_ref ? ` · order ${h.order_ref}` : ''}{h.buyer ? ` · ${h.buyer}` : ''}{h.replacements ? ` · ${h.replacements} replacement already` : ''}</small>
        </button>)}
      </div>
      <div className="actions"><button type="button" className="secondary" onClick={onClose}>Cancel</button></div>
    </> : !confirming ? <>
      <p><strong>Replaces:</strong> {sale.item} · sale #{sale.receipt_no} · SKU {sale.sku} · {sale.channel} · {stamp(sale.sold_at)} <button type="button" className="text-button" onClick={() => setSale(null)}>change</button></p>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend>Is the bad unit coming back to the store?</legend>
        <label className="inventory-check"><input type="radio" name="bad" checked={bad === 'yes'} onChange={() => setBad('yes')} /> Yes (goes into Defective now)</label>
        <label className="inventory-check"><input type="radio" name="bad" checked={bad === 'not_now'} onChange={() => setBad('not_now')} /> Not now (add it later with &quot;Bad unit came back&quot;)</label>
      </fieldset>
      <label>Extra cost of the replacement, optional ($, e.g. the shipping label)<input inputMode="decimal" value={extra} onChange={e => setExtra(e.target.value)} placeholder="0.00" /></label>
      <label>Note, optional<input value={note} onChange={e => setNote(e.target.value)} /></label>
      {extraCents == null && <p className="error" role="alert">Enter the extra cost as dollars, like 6.50.</p>}
      <div className="actions"><button type="button" disabled={!bad || extraCents == null} onClick={() => setConfirming(true)}>Review</button><button type="button" className="secondary" onClick={onClose}>Cancel</button></div>
    </> : <>
      <p>SKU {sku} leaves stock and is delisted from every channel. It is not a sale. Its cost{extraCents ? ` plus ${money(extraCents)} extra` : ''} comes off the profit of sale #{sale.receipt_no}, and that sale&apos;s commission is recalculated.</p>
      <p>Bad unit: {bad === 'yes' ? 'coming back, goes into Defective now.' : 'not back yet.'}</p>
      <div className="actions"><button type="button" disabled={busy} onClick={() => void record()}>{busy ? 'Recording…' : 'Confirm replacement'}</button><button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Back</button></div>
    </>}
  </div></div>;
}

function GiveawayDialog({ client, sku, onClose, onDone }: { client: SupabaseClient; sku: string; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ cost_missing: boolean } | null>(null);
  async function record() {
    setBusy(true); setError('');
    try {
      const { data, error: e } = await client.rpc('portal_record_giveaway', { p_sku: sku, p_given_to: to.trim(), p_note: note.trim() || null });
      if (e) throw e;
      setResult(data as { cost_missing: boolean });
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  }
  return <div className="mboard-modal" role="dialog" aria-modal="true" aria-label="Given away"><div className="mboard-modal-card">
    <h2>Given away · SKU {sku}</h2>
    {error && <div className="alert" role="alert">{error}</div>}
    {result ? <>
      <p>Recorded. SKU {sku} left stock and is being delisted everywhere. It is not a sale: no revenue, no sales tax.</p>
      <p className="hint">{result.cost_missing ? 'No cost is entered for this unit yet. It shows "cost missing" under Expenses → Giveaways until you add one.' : 'Its cost was posted to Expenses → Giveaways.'}</p>
      <div className="actions"><button type="button" onClick={onDone}>Done</button></div>
    </> : !confirming ? <>
      <label>Given to (required)<input autoFocus value={to} onChange={e => setTo(e.target.value)} placeholder="Name" /></label>
      <label>Note, optional<input value={note} onChange={e => setNote(e.target.value)} /></label>
      <div className="actions"><button type="button" disabled={!to.trim()} onClick={() => setConfirming(true)}>Review</button><button type="button" className="secondary" onClick={onClose}>Cancel</button></div>
    </> : <>
      <p>SKU {sku} leaves stock, goes to <strong>{to.trim()}</strong>, and is delisted everywhere. It is not a sale. Its cost posts as a store expense in Giveaways and does not touch anyone&apos;s commission.</p>
      <div className="actions"><button type="button" disabled={busy} onClick={() => void record()}>{busy ? 'Recording…' : 'Confirm giveaway'}</button><button type="button" className="secondary" disabled={busy} onClick={() => setConfirming(false)}>Back</button></div>
    </>}
  </div></div>;
}

/** List of replacements and/or giveaways with Undo (admins) and "Bad unit came back". */
export function DispositionsPanel({ client, money, stamp, kind, title, hint, refreshKey, onChanged }: {
  client: SupabaseClient; money: Money; stamp: Stamp; kind: DispositionKind | null; title: string; hint?: string;
  refreshKey?: number; onChanged?: () => void;
}) {
  const [rows, setRows] = useState<Disposition[] | null>(null);
  const [showUndone, setShowUndone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_dispositions_list', { p_kind: kind });
    if (e) { setError(e.message); return; }
    setError(''); setRows((data || []) as Disposition[]);
  }, [client, kind]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  async function run(id: string, fn: 'portal_undo_disposition' | 'portal_replacement_bad_unit_returned', confirm?: string) {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(id); setError('');
    const { error: e } = await client.rpc(fn, { p_id: id });
    setBusy(null);
    if (e) { setError(errText(e)); return; }
    await load(); onChanged?.();
  }

  const shown = (rows || []).filter(r => showUndone || !r.undone_at);
  return <section className="panel">
    <h2>{title}</h2>
    {hint && <p className="hint">{hint}</p>}
    {error && <div className="alert" role="alert">{error}</div>}
    <label className="inventory-check"><input type="checkbox" checked={showUndone} onChange={e => setShowUndone(e.target.checked)} /> Show undone</label>
    {rows === null ? <p className="hint">Loading…</p> : shown.length === 0 ? <div className="empty">Nothing recorded.</div> : <div className="ticket-list">
      {shown.map(d => <div className="ticket" key={d.id} style={d.undone_at ? { opacity: 0.55 } : undefined}>
        <div className="ticket-top">
          <strong>{d.kind === 'replacement' ? 'Replacement' : 'Given away'} · {d.item}</strong>
          <span>SKU {d.sku} · {costLabel(d, money)}</span>
        </div>
        <small>
          {stamp(d.created_at)} · recorded by {d.recorded_by_name || 'admin'}
          {d.kind === 'giveaway' && <> · to {d.given_to}</>}
          {d.kind === 'replacement' && <> · for sale #{d.original_receipt_no} (SKU {d.original_sku}{d.original_channel ? `, ${d.original_channel}` : ''})</>}
          {d.note ? ` · ${d.note}` : ''}
          {d.kind === 'replacement' && (d.bad_unit_status === 'returned' ? ` · bad unit in Defective as SKU ${d.bad_unit_sku}` : ' · bad unit not back yet')}
          {d.undone_at && ` · undone ${stamp(d.undone_at)} by ${d.undone_by_name || 'admin'}`}
        </small>
        {!d.undone_at && <div className="actions">
          {d.kind === 'replacement' && d.bad_unit_status === 'pending' && <button type="button" className="secondary" disabled={busy === d.id} onClick={() => void run(d.id, 'portal_replacement_bad_unit_returned')}>Bad unit came back</button>}
          <button type="button" className="text-button danger" disabled={busy === d.id} onClick={() => void run(d.id, 'portal_undo_disposition', `Undo this ${d.kind}? SKU ${d.sku} goes back to stock and the cost and commission effects reverse.`)}>Undo</button>
        </div>}
      </div>)}
    </div>}
  </section>;
}

/** Read-only history lines for one unit (events written by the replacement / giveaway RPCs). */
export function UnitDispositionHistory({ client, sku, stamp }: { client: SupabaseClient; sku: string; stamp: Stamp }) {
  const [rows, setRows] = useState<{ at: string; kind: string; actor: string; note: string | null }[]>([]);
  useEffect(() => {
    let alive = true;
    void Promise.resolve(client.rpc('portal_unit_history', { p_sku: sku })).then(({ data }) => { if (alive && Array.isArray(data)) setRows(data); });
    return () => { alive = false; };
  }, [client, sku]);
  if (!rows.length) return null;
  return <><h3>History</h3><div className="inventory-listings">{rows.map((r, i) => <div key={i}><strong>{r.note}</strong><span>{stamp(r.at)} · {r.actor}</span></div>)}</div></>;
}
