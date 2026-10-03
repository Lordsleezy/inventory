import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ReceivePanel } from './ReceivePanel';
import { VideoScanBudget } from './VideoScanBudget';
import { UnitShippingPanel } from './UnitShippingPanel';

type Row = {
  sku: string; brand: string; model: string; title: string; condition: string | null;
  ask_cents: number | null; acquisition_cost_cents: number | null; state: string;
  received_at: string; photo_path: string | null; photo_count: number;
};
type Listing = { channel: string; status: string; listing_id: string | null };
type Photo = { id: number; path: string; is_primary: boolean };
type Sale = { sold_at: string; price_cents: number; actor_name: string; receipt_no: string };
type Detail = { unit: Record<string, unknown>; photos: Photo[]; listings: Listing[]; sales: Sale[] };
type List = { items: Row[]; totals: { unit_count: number; retail_cents: number; cost_cents: number; missing_cost: number } };
type Props = { client: SupabaseClient; storeId: string; money: (n: number) => string; stamp: (s: string) => string };

const label = (s: string) => s === 'available' ? 'In stock' : s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const name = (u: Row) => [u.brand, u.model].filter(Boolean).join(' ') || u.title || 'Untitled unit';
function thumb(path: string) {
  const parts = path.split('/');
  if (parts.length < 3 || parts[1] === 'archive' || parts[2] === 'web') return path;
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  return `${parts[0]}/${parts[1]}/web/400/${stem}.webp`;
}

export function InventoryPage({ client, storeId, money, stamp }: Props) {
  const [tab, setTab] = useState<'browse' | 'receive'>('browse');
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('in_stock');
  const [unfinished, setUnfinished] = useState(false);
  const [sort, setSort] = useState('sku');
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<List | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function sign(paths: string[]) {
    const keys = [...new Set(paths.filter(p => /^[0-9a-f-]{36}\//i.test(p)))];
    if (!keys.length) return {} as Record<string, string>;
    const { data, error: e } = await client.storage.from('unit-photos').createSignedUrls(keys, 3600);
    if (e) throw e;
    return Object.fromEntries((data || []).map((x, i) => [keys[i], x.signedUrl || '']));
  }

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => { setLoading(true); setError(''); void (async () => {
      try {
        const { data, error: e } = await client.rpc('portal_inventory_list', {
          p_query: query, p_status: status, p_unfinished: unfinished,
          p_sort: sort, p_offset: offset, p_limit: 24
        });
        if (e) throw e;
        const next = data as List;
        const signed = await sign(next.items.flatMap(x => x.photo_path ? [thumb(x.photo_path), x.photo_path] : [])).catch(() => ({}));
        if (active) { setList(next); setUrls(prev => ({ ...prev, ...signed })); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
      finally { if (active) setLoading(false); }
    })(); }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [client, query, status, unfinished, sort, offset, refresh]);

  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let active = true; setDetail(null);
    void (async () => {
      try {
        const { data, error: e } = await client.rpc('portal_inventory_detail', { p_sku: selected });
        if (e) throw e;
        if (!data) throw new Error('Unit not found');
        const next = data as Detail;
        const signed = await sign(next.photos.map(x => x.path)).catch(() => ({}));
        if (active) { setDetail(next); setUrls(prev => ({ ...prev, ...signed })); }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { active = false; };
  }, [client, selected]);

  const change = (set: () => void) => { set(); setOffset(0); setList(null); };
  const total = list?.totals.unit_count || 0;
  return <>
    <header><div><div className="eyebrow">FLOOR INVENTORY</div><h1>Inventory</h1><p>{tab === 'browse' ? 'View only (except online shipping). Edit other unit fields in the register or phone app.' : 'Add physical units to Floor.'}</p></div></header>
    <div className="inventory-tabs"><button className={tab === 'browse' ? 'active' : ''} onClick={() => setTab('browse')}>Browse</button><button className={tab === 'receive' ? 'active' : ''} onClick={() => setTab('receive')}>Receive</button></div>
    {tab === 'receive' ? <><VideoScanBudget client={client} /><ReceivePanel client={client} storeId={storeId} onSaved={() => setRefresh(n => n + 1)} /></> : <>
    <div className="inventory-controls">
      <label>Search<input type="search" placeholder="SKU, brand, model or title" value={query} onChange={e => change(() => setQuery(e.target.value))} /></label>
      <label>Status<select value={status} onChange={e => change(() => setStatus(e.target.value))}>
        <option value="in_stock">In stock</option><option value="all">All</option><option value="sold">Sold</option>
        <option value="reserved">Reserved</option><option value="repair">Repair</option>
        <option value="delisted">Delisted listing</option><option value="voided">Voided</option>
        <option value="scrapped">Scrapped</option><option value="lost">Lost</option>
      </select></label>
      <label>Sort<select value={sort} onChange={e => change(() => setSort(e.target.value))}>
        <option value="sku">SKU (newest)</option><option value="price">Price (low to high)</option>
        <option value="date">Date added (newest)</option>
      </select></label>
      <label className="inventory-check"><input type="checkbox" checked={unfinished} onChange={e => change(() => setUnfinished(e.target.checked))} />Unfinished</label>
    </div>
    {error && <div className="alert" role="alert">{error}</div>}
    <div className="stats inventory-stats">
      <div className="stat"><span>Units</span><strong>{total}</strong></div>
      <div className="stat"><span>Retail value</span><strong>{money(list?.totals.retail_cents || 0)}</strong></div>
      <div className="stat"><span>Missing cost</span><strong>{list?.totals.missing_cost || 0}</strong></div>
    </div>
    <section className="panel inventory-panel">
      {loading && <p className="hint">Loading inventory…</p>}
      {!loading && list?.items.length === 0 && <div className="empty">No units match this filter.</div>}
      {list?.items.map(u => <button type="button" className="inventory-row" key={u.sku} onClick={() => setSelected(u.sku)}>
        <span className="inventory-photo">{u.photo_path && urls[u.photo_path] ? <img loading="lazy" src={urls[thumb(u.photo_path)] || urls[u.photo_path]} onError={e => { const fallback = urls[u.photo_path!]; if (e.currentTarget.src !== fallback) e.currentTarget.src = fallback; }} alt="" /> : 'No photo'}</span>
        <span className="inventory-identity"><strong>{name(u)}</strong><small>SKU {u.sku}{u.title && u.title !== name(u) ? ` · ${u.title}` : ''}</small></span>
        <span className="inventory-meta">{u.condition || 'No grade'}<small>{label(u.state)}</small></span>
        <span className="inventory-money"><strong>{u.ask_cents === null ? 'No price' : money(u.ask_cents)}</strong><small>Cost {u.acquisition_cost_cents === null ? 'missing' : money(u.acquisition_cost_cents)}</small></span>
      </button>)}
    </section>
    {total > 24 && <div className="inventory-pagination"><button className="secondary" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 24))}>Previous</button><span>{offset + 1}–{Math.min(offset + 24, total)} of {total}</span><button className="secondary" disabled={offset + 24 >= total || loading} onClick={() => setOffset(offset + 24)}>Next</button></div>}
    {selected && <div className="inventory-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setSelected(null); }}><section className="inventory-detail" role="dialog" aria-modal="true" aria-label={`Unit ${selected}`}>
      <div className="section-head"><div><div className="eyebrow">UNIT DETAILS</div><h2>SKU {selected}</h2></div><button className="secondary" onClick={() => setSelected(null)}>Close</button></div>
      {!detail ? <p>Loading…</p> : <>
        <h3>Photos</h3>{detail.photos.length ? <div className="inventory-gallery">{detail.photos.map(p => urls[p.path] ? <img src={urls[p.path]} alt={`Unit ${selected}`} key={p.id} loading="lazy" /> : <div className="inventory-photo" key={p.id}>Photo unavailable</div>)}</div> : <p>No photos recorded.</p>}
        <UnitShippingPanel client={client} sku={selected} />
        <h3>Unit fields</h3><dl className="inventory-fields">{Object.entries(detail.unit).map(([key, value]) => <div key={key}><dt>{key.replace(/_/g, ' ')}</dt><dd>{value === null ? '—' : key.endsWith('_cents') ? money(Number(value)) : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd></div>)}</dl>
        <h3>Channel listings</h3>{detail.listings.length ? <div className="inventory-listings">{detail.listings.map(l => <div key={l.channel}><strong>{l.channel}</strong><span>{l.status.replace(/_/g, ' ')}{l.listing_id ? ` · ${l.listing_id}` : ''}</span></div>)}</div> : <p>No channel listings recorded.</p>}
        <h3>Sales</h3>{detail.sales.length ? <div className="inventory-listings">{detail.sales.map(s => <div key={s.receipt_no}><strong>{stamp(s.sold_at)} · {money(s.price_cents)} merchandise</strong><span>Rang up by {s.actor_name} · Receipt {s.receipt_no}</span></div>)}</div> : <p>No sale recorded.</p>}
      </>}
    </section></div>}
    </>}
  </>;
}
