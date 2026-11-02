import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { errText } from './errText';
import { MercariSalePanel } from './MercariSalePanel';

type Row = { sku: string; price_cents: number | null; listing_url: string | null; listed_at: string | null; unit_state: string; do_not_list: boolean; defective: boolean };
type Hit = { sku: string; title: string; photo_path: string | null; unit_state: string; do_not_list: boolean; defective: boolean };
type Cap = { live: number; cap: number };

const CAP = 200;
const todayLA = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const startOfWeekLA = () => { const d = new Date(`${todayLA()}T12:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toLocaleDateString('en-CA'); };

function parseBulkLines(text: string): { sku: string; url?: string; price_cents?: number }[] {
  const out: { sku: string; url?: string; price_cents?: number }[] = [];
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/[\s,|\t]+/).map(p => p.trim()).filter(Boolean);
    let sku = '';
    let url: string | undefined;
    let price: number | undefined;
    for (const p of parts) {
      if (/^https?:\/\//i.test(p)) { url = p; continue; }
      if (/^\d+\.\d{1,2}$/.test(p)) { price = Math.round(Number(p) * 100); continue; }
      if (/^\d{4,}$/.test(p) && !sku) { sku = p; continue; }
      if (/^\d+(\.\d{1,2})?$/.test(p) && sku) { price = Math.round(Number(p) * 100); continue; }
      if (!sku) sku = p;
    }
    if (!sku) continue;
    const row: { sku: string; url?: string; price_cents?: number } = { sku };
    if (url) row.url = url;
    if (price != null && Number.isFinite(price)) row.price_cents = price;
    out.push(row);
  }
  return out;
}

export function MercariLiveListingsPanel({ client, money, variant }: { client: SupabaseClient; money: (n: number) => string; variant: 'desktop' | 'app' }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cap, setCap] = useState<Cap>({ live: 0, cap: CAP });
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [picked, setPicked] = useState<Hit | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [adding, setAdding] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [url, setUrl] = useState('');
  const [price, setPrice] = useState('');
  const [listedOn, setListedOn] = useState(todayLA());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [list, count] = await Promise.all([
      client.rpc('portal_mercari_live_listings'),
      client.rpc('portal_mercari_live_count'),
    ]);
    if (list.error) { setError(errText(list.error)); return; }
    setRows((list.data || []) as Row[]);
    if (!count.error && count.data) setCap(count.data as Cap);
    else setCap({ live: ((list.data || []) as Row[]).length, cap: CAP });
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!query.trim()) { setHits([]); return; }
    let alive = true;
    const timer = setTimeout(() => { void client.rpc('portal_mercari_find_listing_units', { p_query: query.trim() }).then(({ data }) => { if (alive) setHits((data || []) as Hit[]); }); }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [client, query]);

  const soldElsewhere = useMemo(() => (rows || []).filter(row => ['sold', 'replaced', 'given_away'].includes(row.unit_state)).length, [rows]);
  const listedThisWeek = useMemo(() => (rows || []).filter(row => row.listed_at && row.listed_at.slice(0, 10) >= startOfWeekLA()).length, [rows]);
  const shown = (rows || []).filter(row => row.sku.toLowerCase().includes(search.trim().toLowerCase()));
  const atCap = cap.live >= cap.cap;

  async function add(e: React.FormEvent) {
    e.preventDefault(); if (!picked) return;
    if (atCap) { setError(`Mercari is at ${cap.live} / ${cap.cap}. Remove a live listing before adding more.`); return; }
    const cents = Math.round(Number(price) * 100);
    if (!Number.isInteger(cents) || cents < 0) { setError('Enter a valid Mercari price.'); return; }
    setBusy(true); setError(''); setNotice('');
    const { error: e2 } = await client.rpc('portal_mercari_add_listing', { p_sku: picked.sku, p_url: url.trim(), p_price_cents: cents, p_listed_at: listedOn });
    setBusy(false);
    if (e2) { setError(errText(e2)); return; }
    setNotice(`SKU ${picked.sku} added to the live Mercari list.`); setAdding(false); setPicked(null); setQuery(''); setUrl(''); setPrice(''); setListedOn(todayLA()); await load();
  }

  async function bulkAdd(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseBulkLines(bulkText);
    if (parsed.length === 0) { setError('Paste one SKU per line. Optional: URL and price after the SKU.'); return; }
    if (cap.live + parsed.length > cap.cap) {
      setError(`That would put Mercari over ${cap.cap} live listings (now ${cap.live}). Trim the paste or remove listings first.`);
      return;
    }
    setBusy(true); setError(''); setNotice('');
    const { data, error: e2 } = await client.rpc('portal_mercari_bulk_add_listings', { p_rows: parsed });
    setBusy(false);
    if (e2) { setError(errText(e2)); return; }
    const r = data as { added: number; skipped: number; errors: { sku?: string; error: string }[]; live: number; cap: number };
    const errN = r.errors?.length || 0;
    setNotice(`Bulk load: ${r.added} added, ${r.skipped} already listed${errN ? `, ${errN} failed` : ''}. Now ${r.live} / ${r.cap}.`);
    if (errN) setError(r.errors.slice(0, 5).map(x => `${x.sku || '?'}: ${x.error}`).join(' · '));
    setBulkOpen(false); setBulkText(''); await load();
  }

  async function remove(row: Row) {
    if (!window.confirm(`Remove SKU ${row.sku} from the live Mercari list?`)) return;
    setBusy(true); setError('');
    const { error: e } = await client.rpc('portal_mercari_remove_listing', { p_sku: row.sku });
    setBusy(false); if (e) { setError(errText(e)); return; }
    setNotice(`SKU ${row.sku} removed from the live Mercari list.`); await load();
  }

  const cls = variant === 'app' ? 'depop-live depop-live-app' : 'depop-live';
  return <div className={cls}>
    <section className="panel depop-live-summary">
      <div className="depop-live-top">
        <strong className="depop-live-count">{rows === null ? '…' : `${cap.live} / ${cap.cap}`}</strong>
        <span>live on Mercari</span>
        <button type="button" className="text-button" onClick={() => { setBulkOpen(v => !v); setAdding(false); setSelected(null); setError(''); }}>{bulkOpen ? 'Cancel' : 'Bulk load'}</button>
        <button type="button" className="text-button" disabled={atCap && !adding} onClick={() => { setAdding(v => !v); setBulkOpen(false); setSelected(null); setError(''); }}>{adding ? 'Cancel' : '+ Add'}</button>
      </div>
      <div className="depop-live-metrics">
        <div className={soldElsewhere ? 'depop-live-sold' : ''}><strong>{soldElsewhere}</strong><span>Sold elsewhere, pull now</span></div>
        <div><strong>{listedThisWeek}</strong><span>Listed this week</span></div>
      </div>
      {atCap && !adding && !bulkOpen && <p className="hint" role="status">Mercari listing cap reached ({cap.cap}). Remove a listing before adding more.</p>}
      {bulkOpen && <form className="depop-form" onSubmit={e => void bulkAdd(e)}>
        <label>Paste SKUs (one per line). Optional URL and price after the SKU.
          <textarea rows={8} value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder={'11401 https://www.mercari.com/us/item/… 24.99\n11402\n11403 https://www.mercari.com/us/item/…'} />
        </label>
        <button disabled={busy || !bulkText.trim()}>{busy ? 'Loading…' : 'Add live listings'}</button>
      </form>}
      {adding && <form className="depop-form" onSubmit={e => void add(e)}>
        <label>Find SKU<input autoFocus type="search" value={query} placeholder="Search SKU or item" onChange={e => setQuery(e.target.value)} /></label>
        {hits.length > 0 && !picked && <div className="depop-hits">{hits.map(hit => <button type="button" key={hit.sku} onClick={() => { setPicked(hit); setHits([]); }}><strong>SKU {hit.sku}</strong><small>{hit.title} · {hit.unit_state}</small></button>)}</div>}
        {picked && <div className="depop-picked"><strong>SKU {picked.sku}</strong><small>{picked.title}</small><button type="button" className="text-button" onClick={() => setPicked(null)}>change</button></div>}
        <label>Mercari listing URL<input type="url" required value={url} onChange={e => setUrl(e.target.value)} placeholder="https://www.mercari.com/us/item/…" /></label>
        <label>Price ($)<input required inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></label>
        <label>Listed on<input required type="date" max={todayLA()} value={listedOn} onChange={e => setListedOn(e.target.value)} /></label>
        <button disabled={busy || !picked || atCap}>{busy ? 'Saving…' : 'Add live listing'}</button>
      </form>}
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="hint" role="status">{notice}</p>}
    </section>
    {!adding && !bulkOpen && !selected && <section className="panel"><label>Search SKU<input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU" /></label>
      {rows === null ? <p className="hint">Loading Mercari SKUs…</p> : shown.length === 0 ? <div className="empty">No matching live Mercari SKUs.</div> : <div className="depop-sku-list">{shown.map(row => {
        const sold = ['sold', 'replaced', 'given_away'].includes(row.unit_state);
        return <div className={`depop-sku-row${sold ? ' sold-elsewhere' : ''}`} key={row.sku}>
          <button type="button" className="depop-sku-open" onClick={() => { setError(''); setSelected(row); }}><strong>{row.sku}</strong>{sold && <span>Sold elsewhere</span>}<b aria-hidden="true">›</b></button>
          <button type="button" className="text-button depop-remove" disabled={busy} onClick={() => void remove(row)}>Remove</button>
        </div>;
      })}</div>}
    </section>}
    {selected && <section className="depop-mark-sold"><button type="button" className="text-button" onClick={() => setSelected(null)}>‹ Mercari SKUs</button>
      <MercariSalePanel key={selected.sku} client={client} money={money} variant={variant} initialSku={selected.sku} initialSaleCents={selected.price_cents} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); void load(); }} />
    </section>}
  </div>;
}
