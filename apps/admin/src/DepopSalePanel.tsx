import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { parseDollars } from './dispositions';
import { dollarsText, payoutDefault, type DepopEntry } from './depopMath';

type Money = (n: number) => string;
type UnitHit = { sold_no_sale?: boolean; sku: string; brand: string; model: string; title: string; ask_cents: number | null; acquisition_cost_cents: number | null; state: string; condition: string | null };

const todayLA = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const unitName = (u: Pick<UnitHit, 'brand' | 'model' | 'title'>) => [u.brand, u.model].filter(Boolean).join(' ') || u.title || 'Untitled unit';

/** Depop sales are typed in by hand: pick the unit, price, Depop fee, payout, date. Admins only (the server enforces it). */
export function DepopSalePanel({ client, money, variant, initialSku, initialSaleCents, onClose, onSaved }: { client: SupabaseClient; money: Money; variant: 'desktop' | 'app'; initialSku?: string; initialSaleCents?: number | null; onClose?: () => void; onSaved?: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UnitHit[]>([]);
  const [unit, setUnit] = useState<UnitHit | null>(null);
  const [editing, setEditing] = useState<DepopEntry | null>(null);
  const [sale, setSale] = useState('');
  const [fee, setFee] = useState('');
  const [payout, setPayout] = useState('');
  const [payoutTouched, setPayoutTouched] = useState(false);
  const [day, setDay] = useState(todayLA());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [entries, setEntries] = useState<DepopEntry[] | null>(null);

  const loadEntries = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_depop_entries', { p_limit: 50 });
    if (e) { setError(e.message); return; }
    setEntries((data || []) as DepopEntry[]);
  }, [client]);
  useEffect(() => { void loadEntries(); }, [loadEntries]);

  useEffect(() => {
    if (!initialSku) return;
    let alive = true;
    void client.rpc('portal_depop_find_units', { p_query: initialSku }).then(({ data, error: e }) => {
      if (!alive) return;
      const exact = ((data || []) as UnitHit[]).find(row => row.sku === initialSku);
      if (e) setError(e.message);
      else if (!exact) setError(`SKU ${initialSku} could not be loaded.`);
      else {
        setUnit(exact);
        if (initialSaleCents != null) setSale(dollarsText(initialSaleCents));
      }
    });
    return () => { alive = false; };
  }, [client, initialSku, initialSaleCents]);

  useEffect(() => {
    if (unit || editing || query.trim().length < 2) { setHits([]); return; }
    let alive = true;
    const timer = setTimeout(() => {
      void Promise.resolve(client.rpc('portal_depop_find_units', { p_query: query.trim() })).then(({ data }) => {
        if (alive) setHits((data || []) as UnitHit[]);
      });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [client, query, unit, editing]);

  const saleCents = parseDollars(sale);
  const feeCents = parseDollars(fee);
  const suggested = payoutDefault(saleCents, feeCents);
  const shownPayout = payoutTouched ? payout : suggested == null ? '' : dollarsText(suggested);
  const payoutCents = parseDollars(shownPayout);
  const valid = !!(unit || editing) && !!saleCents && saleCents > 0 && feeCents != null && payoutCents != null && payoutCents <= saleCents && !!day;

  function reset() {
    setUnit(null); setEditing(null); setQuery(''); setSale(''); setFee(''); setPayout(''); setPayoutTouched(false); setDay(todayLA());
  }
  function startEdit(e: DepopEntry) {
    setEditing(e); setUnit(null); setSale(dollarsText(e.sale_cents)); setFee(dollarsText(e.fee_cents));
    setPayout(dollarsText(e.payout_cents)); setPayoutTouched(true); setDay(e.sold_on); setNotice(''); setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (!valid || saleCents == null || feeCents == null || payoutCents == null) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (editing) {
        const { error: e } = await client.rpc('portal_depop_update_sale', { p_id: editing.id, p_sale_cents: saleCents, p_fee_cents: feeCents, p_payout_cents: payoutCents, p_sold_on: day, p_note: null });
        if (e) throw e;
        setNotice('Saved. The sale and its commission were recalculated.');
      } else if (unit) {
        const { data, error: e } = await client.rpc('portal_depop_record_sale', { p_sku: unit.sku, p_sale_cents: saleCents, p_fee_cents: feeCents, p_payout_cents: payoutCents, p_sold_on: day, p_note: null });
        if (e) throw e;
        const r = data as { cost_missing: boolean };
        setNotice(r.cost_missing
          ? `Saved. SKU ${unit.sku} is sold, but it has no cost yet, so Paul's payout waits until you enter one.`
          : `Saved. SKU ${unit.sku} is sold and delisted everywhere else.`);
      }
      reset();
      await loadEntries();
      onSaved?.();
    } catch (err) { setError(errText(err)); } finally { setBusy(false); }
  }

  async function remove(e: DepopEntry) {
    if (!window.confirm(`Delete this Depop sale of SKU ${e.sku}? The sale comes out of the books and the unit goes back in stock.`)) return;
    setBusy(true); setError(''); setNotice('');
    const { error: err } = await client.rpc('portal_depop_delete_sale', { p_id: e.id });
    setBusy(false);
    if (err) { setError(errText(err)); return; }
    if (editing?.id === e.id) reset();
    setNotice(`Deleted. SKU ${e.sku} is back in stock.`);
    await loadEntries();
  }

  const cls = variant === 'app' ? 'depop-panel depop-app' : 'depop-panel';
  return <div className={cls}>
    <section className="panel">
      <h2>{initialSku ? 'Mark sold' : editing ? `Edit Depop sale · SKU ${editing.sku}` : 'Record a Depop sale'}</h2>
      <form className="depop-form" onSubmit={e => void save(e)}>
        {!editing && (unit
          ? <div className="depop-picked"><strong>{unitName(unit)}</strong><small>SKU {unit.sku}{unit.sold_no_sale ? ' · Sold, no sale recorded' : ''}{unit.acquisition_cost_cents == null ? ' · no cost yet' : ` · cost ${money(unit.acquisition_cost_cents)}`}</small>
              <button type="button" className="text-button" onClick={() => { setUnit(null); setQuery(''); }}>change</button></div>
          : <label>Item (SKU or search)<input type="search" autoFocus value={query} placeholder="SKU, brand, model or title" onChange={e => setQuery(e.target.value)} />
              {hits.length > 0 && <div className="depop-hits">{hits.map(h => <button type="button" key={h.sku} onClick={() => { setUnit(h); setHits([]); if (!sale && h.ask_cents) setSale(dollarsText(h.ask_cents)); }}>
                <strong>{unitName(h)}</strong><small>SKU {h.sku} · {h.sold_no_sale ? 'Sold, no sale recorded' : h.condition || 'No grade'}{h.ask_cents != null ? ` · ${money(h.ask_cents)}` : ''}</small></button>)}</div>}
            </label>)}
        <label>Sale price ($)<input inputMode="decimal" value={sale} onChange={e => setSale(e.target.value)} placeholder="0.00" /></label>
        <label>Depop fee ($)<input inputMode="decimal" value={fee} onChange={e => setFee(e.target.value)} placeholder="0.00" /></label>
        <label>Payout, what Depop paid me ($)<input inputMode="decimal" value={shownPayout} onChange={e => { setPayoutTouched(true); setPayout(e.target.value); }} placeholder="0.00" /></label>
        <label>Sale date<input type="date" value={day} max={todayLA()} onChange={e => setDay(e.target.value)} /></label>
        {payoutCents != null && saleCents != null && payoutCents > saleCents && <p className="error" role="alert">The payout can&apos;t be more than the sale price.</p>}
        {(sale && saleCents == null) || (fee && feeCents == null) || (shownPayout && payoutCents == null) ? <p className="error" role="alert">Enter amounts as dollars, like 24.99.</p> : null}
        <div className="actions"><button disabled={busy || !valid}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save sale'}</button>
          {(editing || unit) && <button type="button" className="secondary" disabled={busy} onClick={reset}>Cancel</button>}</div>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="hint" role="status">{notice}</p>}
      <p className="hint">Profit = payout − cost. Saving marks the unit sold, removes it from the live Depop list, and puts the order in Orders → To ship.</p>
      {initialSku && onClose && <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>}
    </section>
    {!initialSku && <section className="panel">
      <h2>Recent Depop entries</h2>
      {entries === null ? <p className="hint">Loading…</p> : entries.length === 0 ? <div className="empty">No Depop sales entered yet.</div> : <div className="ticket-list">
        {entries.map(e => <div className="ticket" key={e.id}>
          <div className="ticket-top"><strong>{e.item}</strong><span>{money(e.sale_cents)}</span></div>
          <small>SKU {e.sku} · {e.sold_on} · fee {money(e.fee_cents)} · payout {money(e.payout_cents)} · {e.cost_missing || e.profit_cents == null ? 'cost missing, payout waits' : `profit ${money(e.profit_cents)}`}</small>
          <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={() => startEdit(e)}>Edit</button>
            <button type="button" className="text-button danger" disabled={busy} onClick={() => void remove(e)}>Delete</button></div>
        </div>)}
      </div>}
    </section>}
  </div>;
}
