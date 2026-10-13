import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ReceivePanel } from './ReceivePanel';
import { NeedsAttentionPanel } from './NeedsAttentionPanel';
import { UnitEditDrawer } from './UnitEditDrawer';
import { LookupTestPage } from './LookupTestPage';
import type { AttentionSection, InventoryTab } from './navigation';

type Row = {
  sku: string; brand: string; model: string; title: string; condition: string | null;
  ask_cents: number | null; acquisition_cost_cents: number | null; state: string;
  received_at: string; photo_path: string | null; photo_count: number;
};
type Listing = { channel: string; status: string; listing_id: string | null };
type Photo = { id: number; path: string; is_primary: boolean };
type Sale = { sold_at: string; price_cents: number; actor_name: string; receipt_no: string };
type Detail = { unit: Record<string, unknown>; photos: Photo[]; listings: Listing[]; sales: Sale[] };
type List = { items: Row[]; totals: { unit_count: number; cost_cents?: number; missing_cost?: number } };
type Props = {
  client: SupabaseClient; storeId: string; accessToken: string; money: (n: number) => string; stamp: (s: string) => string;
  tab: InventoryTab; onTab: (t: InventoryTab) => void;
  attentionSection: AttentionSection; onAttentionSection: (s: AttentionSection) => void;
  onCostChanged: () => void;
};

const label = (s: string) => s === 'available' ? 'In stock' : s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const name = (u: Row) => [u.brand, u.model].filter(Boolean).join(' ') || u.title || 'Untitled unit';
function thumb(path: string) {
  const parts = path.split('/');
  if (parts.length < 3 || parts[1] === 'archive' || parts[2] === 'web') return path;
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  return `${parts[0]}/${parts[1]}/web/400/${stem}.webp`;
}

export function InventoryPage({ client, storeId, accessToken, money, stamp, tab, onTab, attentionSection, onAttentionSection, onCostChanged }: Props) {
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
  const [detailKey, setDetailKey] = useState(0);

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
        if (active) {
          setDetail(next);
          setUrls(prev => ({ ...prev, ...signed }));
        }
      } catch (e) { if (active) setError(e instanceof Error ? e.message : String(e)); }
    })();
    return () => { active = false; };
  }, [client, selected, detailKey]);

  const change = (set: () => void) => { set(); setOffset(0); setList(null); };
  const total = list?.totals.unit_count || 0;
  return <>
    <header><div><div className="eyebrow">FLOOR INVENTORY</div><h1>Inventory</h1><p>{tab === 'browse' ? 'Click a unit to edit SKU details, price, cost, package size, and photos.' : tab === 'receive' ? 'Scan a UPC to look up product data, then receive with a real photo.' : tab === 'lookup-test' ? 'Read-only UPC accuracy test — Amazon vs UPCitemdb. Does not create inventory.' : 'Units missing cost, photo, price, model, description, or package specs.'}</p></div></header>
    <div className="inventory-tabs">
      <button type="button" className={tab === 'browse' ? 'active' : ''} onClick={() => onTab('browse')}>Browse</button>
      <button type="button" className={tab === 'receive' ? 'active' : ''} onClick={() => onTab('receive')}>Receive</button>
      <button type="button" className={tab === 'attention' ? 'active' : ''} onClick={() => onTab('attention')}>Needs attention</button>
      <button type="button" className={tab === 'lookup-test' ? 'active' : ''} onClick={() => onTab('lookup-test')}>Lookup test</button>
    </div>
    {tab === 'lookup-test' ? <LookupTestPage accessToken={accessToken} /> : tab === 'receive' ? <ReceivePanel client={client} storeId={storeId} accessToken={accessToken} onSaved={() => setRefresh(n => n + 1)} /> : tab === 'attention' ? <NeedsAttentionPanel client={client} storeId={storeId} money={money} stamp={stamp} section={attentionSection} onSection={onAttentionSection} onCostChanged={onCostChanged} /> : <>
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
    <div className="stats inventory-stats inventory-stats-one">
      <div className="stat"><span>Units</span><strong>{total}</strong></div>
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
    {selected && detail && <UnitEditDrawer
      client={client}
      storeId={storeId}
      sku={selected}
      unit={detail.unit}
      photos={detail.photos}
      urls={urls}
      accessToken={accessToken}
      onClose={() => setSelected(null)}
      onSaved={(unit) => {
        setDetail(d => d ? { ...d, unit } : d);
        setRefresh(n => n + 1);
        onCostChanged();
      }}
      onPhotosChanged={() => setDetailKey(k => k + 1)}
    />}
    {selected && !detail && <div className="inventory-backdrop"><section className="inventory-detail"><p>Loading…</p></section></div>}
    </>}
  </>;
}
