import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { DepopSalePanel } from './DepopSalePanel';

type Row = { sku: string; price_cents: number | null; listing_url: string | null; listed_at: string | null; unit_state: string; do_not_list: boolean; defective: boolean };
type Hit = { sku: string; title: string; photo_path: string | null; unit_state: string; do_not_list: boolean; defective: boolean };
const todayLA = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const startOfWeekLA = () => { const d = new Date(`${todayLA()}T12:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toLocaleDateString('en-CA'); };

export function DepopLiveListingsPanel({ client, money, variant }: { client: SupabaseClient; money: (n: number) => string; variant: 'desktop' | 'app' }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [picked, setPicked] = useState<Hit | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [price, setPrice] = useState('');
  const [listedOn, setListedOn] = useState(todayLA());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_depop_live_listings');
    if (e) { setError(errText(e)); return; }
    setRows((data || []) as Row[]);
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!query.trim()) { setHits([]); return; }
    let alive = true;
    const timer = setTimeout(() => { void client.rpc('portal_depop_find_listing_units', { p_query: query.trim() }).then(({ data }) => { if (alive) setHits((data || []) as Hit[]); }); }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [client, query]);

  const soldElsewhere = useMemo(() => (rows || []).filter(row => ['sold', 'replaced', 'given_away'].includes(row.unit_state)).length, [rows]);
  const listedThisWeek = useMemo(() => (rows || []).filter(row => row.listed_at && row.listed_at.slice(0, 10) >= startOfWeekLA()).length, [rows]);
  const shown = (rows || []).filter(row => row.sku.toLowerCase().includes(search.trim().toLowerCase()));
  async function add(e: React.FormEvent) {
    e.preventDefault(); if (!picked) return;
    const cents = Math.round(Number(price) * 100);
    if (!Number.isInteger(cents) || cents < 0) { setError('Enter a valid Depop price.'); return; }
    setBusy(true); setError(''); setNotice('');
    const { error: e2 } = await client.rpc('portal_depop_add_listing', { p_sku: picked.sku, p_url: url.trim(), p_price_cents: cents, p_listed_at: listedOn });
    setBusy(false);
    if (e2) { setError(errText(e2)); return; }
    setNotice(`SKU ${picked.sku} added to the live Depop list.`); setAdding(false); setPicked(null); setQuery(''); setUrl(''); setPrice(''); setListedOn(todayLA()); await load();
  }
  async function remove(row: Row) {
    if (!window.confirm(`Remove SKU ${row.sku} from the live Depop list?`)) return;
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_depop_remove_listing', { p_sku: row.sku });
    setBusy(false); if (e) { setError(errText(e)); return; }
    setNotice(`SKU ${row.sku} removed from the live Depop list.`); await load();
  }

  const cls = variant === 'app' ? 'depop-live depop-live-app' : 'depop-live';
  return <div className={cls}>
    <section className="panel depop-live-summary">
      <div className="depop-live-top"><strong className="depop-live-count">{rows === null ? '…' : rows.length}</strong><span>live on Depop</span><button type="button" className="text-button" onClick={() => { setAdding(v => !v); setSelected(null); setError(''); }}>{adding ? 'Cancel' : '+ Add'}</button></div>
      <div className="depop-live-metrics"><div className={soldElsewhere ? 'depop-live-sold' : ''}><strong>{soldElsewhere}</strong><span>Sold elsewhere, pull now</span></div><div><strong>{listedThisWeek}</strong><span>Listed this week</span></div></div>
      {adding && <form className="depop-form" onSubmit={e => void add(e)}>
        <label>Find SKU<input autoFocus type="search" value={query} placeholder="Search SKU or item" onChange={e => setQuery(e.target.value)} /></label>
        {hits.length > 0 && !picked && <div className="depop-hits">{hits.map(hit => <button type="button" key={hit.sku} onClick={() => { setPicked(hit); setHits([]); }}><strong>SKU {hit.sku}</strong><small>{hit.title} · {hit.unit_state}</small></button>)}</div>}
        {picked && <div className="depop-picked"><strong>SKU {picked.sku}</strong><small>{picked.title}</small><button type="button" className="text-button" onClick={() => setPicked(null)}>change</button></div>}
        <label>Depop listing URL<input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.depop.com/products/…" /></label>
        <label>Price ($)<input required inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></label>
        <label>Listed on<input required type="date" max={todayLA()} value={listedOn} onChange={e => setListedOn(e.target.value)} /></label>
        <button disabled={busy || !picked}>{busy ? 'Saving…' : 'Add live listing'}</button>
      </form>}
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="hint" role="status">{notice}</p>}
    </section>
    {!adding && !selected && <section className="panel"><label>Search SKU<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU" /></label>
      {rows === null ? <p className="hint">Loading Depop SKUs…</p> : shown.length === 0 ? <div className="empty">No matching live Depop SKUs.</div> : <div className="depop-sku-list">{shown.map(row => {
        const sold = ['sold', 'replaced', 'given_away'].includes(row.unit_state);
        return <div className={`depop-sku-row${sold ? ' sold-elsewhere' : ''}`} key={row.sku}>
          <button type="button" className="depop-sku-open" onClick={() => { setError(''); setSelected(row); }}><strong>{row.sku}</strong>{sold && <span>Sold elsewhere</span>}<b aria-hidden="true">›</b></button>
          <button type="button" className="text-button depop-remove" disabled={busy} onClick={() => void remove(row)}>Removed</button>
        </div>;
      })}</div>}
    </section>}
    {selected && <section className="depop-mark-sold"><button type="button" className="text-button" onClick={() => setSelected(null)}>‹ Depop SKUs</button>
      <DepopSalePanel key={selected.sku} client={client} money={money} variant={variant} initialSku={selected.sku} initialSaleCents={selected.price_cents} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); void load(); }} />
    </section>}
  </div>;
}
