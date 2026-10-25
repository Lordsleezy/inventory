import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ReceivePanel } from './ReceivePanel';
import { ATTENTION_SECTIONS, NeedsAttentionPanel, useAttentionCounts } from './NeedsAttentionPanel';
import { UnitEditDrawer } from './UnitEditDrawer';
import { LookupTestPage } from './LookupTestPage';
import { FloorProductsPage } from './FloorProductsPage';
import { MarkerMatPage } from './MarkerMatPage';
import { CategoryPanel } from './CategoryPanel';
import type { AttentionSection, InventoryTab } from './navigation';
import { errText } from './errText';
import { reviewReasonLabel } from './inventoryReview';
import { DispositionButtons, DispositionsPanel } from './DispositionDialogs';
import { showDispositionButtons } from './dispositions';

type Row = {
  sku: string; brand: string; model: string; title: string; condition: string | null;
  ask_cents: number | null; acquisition_cost_cents: number | null; state: string;
  received_at: string; photo_path: string | null; photo_count: number;
  defective?: boolean; not_for_sale?: boolean; missing?: string[];
  sold_at?: string | null; sold_price_cents?: number | null;
  locations?: string; assigned?: number;
};
type Listing = { channel: string; status: string; listing_id: string | null };
type Photo = { id: number; path: string; is_primary: boolean };
type Sale = { sold_at: string; price_cents: number; actor_name: string; receipt_no: string };
type Detail = { unit: Record<string, unknown>; photos: Photo[]; listings: Listing[]; sales: Sale[] };
type List = { items: Row[]; totals: { unit_count: number; piece_count?: number; cost_cents?: number; missing_cost?: number } };
type Props = {
  client: SupabaseClient; storeId: string; accessToken: string; money: (n: number) => string; stamp: (s: string) => string;
  tab: InventoryTab; onTab: (t: InventoryTab) => void;
  attentionSection: AttentionSection; onAttentionSection: (s: AttentionSection) => void;
  onCostChanged: () => void;
  /** Portal admin / manager — show Delete in the unit editor. */
  canDelete?: boolean;
  /** Associates: list tabs only (no Receive / fix queues / Lookup test). The server also withholds sold prices and cost. */
  associateBrowseOnly?: boolean;
};

/** Unit-list subtabs, in this order. Everything after them is an admin tool. */
const LIST_TABS: [InventoryTab, string][] = [['in-stock', 'In stock'], ['sold', 'Sold'], ['unfinished', 'Unfinished'], ['needs-check', 'Needs to be checked'], ['defective', 'Defective']];
const TOOL_TABS: [InventoryTab, string][] = [['left-store', 'Replaced / given away'], ['missing-category', 'Missing Category'], ['receive', 'Receive'], ['lookup-test', 'Lookup test'], ['products', 'Products'], ['measure-mat', 'Measure mat']];
const MISSING_LABEL: Record<string, string> = { spec: 'weight & box', upc: 'UPC', specifics: 'item specifics' };
const missingText = (m: string[]) => {
  const fields = m.filter(k => !reviewReasonLabel(k));
  const reviews = m.map(reviewReasonLabel).filter((x): x is string => Boolean(x));
  return [fields.length ? `Missing ${fields.map(k => MISSING_LABEL[k] || k).join(', ')}` : '', ...reviews].filter(Boolean).join(' · ');
};

const label = (s: string) => s === 'available' ? 'In stock' : s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
const name = (u: Row) => [u.brand, u.model].filter(Boolean).join(' ') || u.title || 'Untitled unit';
function thumb(path: string) {
  const parts = path.split('/');
  if (parts.length < 3 || parts[1] === 'archive' || parts[2] === 'web') return path;
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  return `${parts[0]}/${parts[1]}/web/400/${stem}.webp`;
}

export function InventoryPage({
  client, storeId, accessToken, money, stamp, tab, onTab, attentionSection, onAttentionSection, onCostChanged,
  canDelete = false,
  associateBrowseOnly = false,
}: Props) {
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('in_stock');
  const [location, setLocation] = useState('all');
  const [locationOptions, setLocationOptions] = useState<{ code: string }[]>([]);
  const [sort, setSort] = useState('sku');
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<List | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailKey, setDetailKey] = useState(0);
  const listTab = LIST_TABS.some(([id]) => id === tab) ? tab : associateBrowseOnly ? 'in-stock' : null;
  const queue = listTab === 'unfinished' && !associateBrowseOnly && attentionSection !== 'all' ? attentionSection : null;
  const counts = useAttentionCounts(client, listTab === 'unfinished' && !associateBrowseOnly, refresh);
  // Status only narrows In stock; the other subtabs have a fixed status.
  const pStatus = listTab === 'sold' ? 'sold' : listTab === 'defective' ? 'defective' : listTab === 'unfinished' ? 'all' : listTab === 'needs-check' ? 'needs_check' : status;
  const pUnfinished = listTab === 'unfinished';
  const hideMoney = associateBrowseOnly && listTab === 'sold';

  useEffect(() => {
    let active = true;
    void client.from('store_locations').select('code').eq('store_id', storeId).order('bay_no')
      .order('row_no').order('bin_no').then(({ data }) => {
        if (active) setLocationOptions(data || []);
      });
    return () => { active = false; };
  }, [client, storeId]);

  async function sign(paths: string[]) {
    const keys = [...new Set(paths.filter(p => /^[0-9a-f-]{36}\//i.test(p)))];
    if (!keys.length) return {} as Record<string, string>;
    const { data, error: e } = await client.storage.from('unit-photos').createSignedUrls(keys, 3600);
    if (e) throw e;
    return Object.fromEntries((data || []).map((x, i) => [keys[i], x.signedUrl || '']));
  }

  useEffect(() => {
    if (!listTab || queue) return;
    let active = true;
    const timer = setTimeout(() => { setLoading(true); setError(''); void (async () => {
      try {
        const { data, error: e } = await client.rpc('portal_inventory_list_with_locations', {
          p_query: query, p_status: pStatus, p_unfinished: pUnfinished,
          p_sort: sort, p_offset: offset, p_limit: 24, p_location: location,
        });
        if (e) throw e;
        const next = data as List;
        const signed = await sign(next.items.flatMap(x => x.photo_path ? [thumb(x.photo_path), x.photo_path] : [])).catch(() => ({}));
        if (active) { setList(next); setUrls(prev => ({ ...prev, ...signed })); }
      } catch (e) { if (active) setError(errText(e)); }
      finally { if (active) setLoading(false); }
    })(); }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [client, listTab, queue, query, pStatus, pUnfinished, sort, offset, refresh, location]);

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
      } catch (e) { if (active) setError(errText(e)); }
    })();
    return () => { active = false; };
  }, [client, selected, detailKey]);

  const change = (set: () => void) => { set(); setOffset(0); setList(null); };
  const pickTab = (t: InventoryTab) => { setOffset(0); setList(null); onTab(t); };
  const total = list?.totals.unit_count || 0;
  return <>
    <header><div><div className="eyebrow">FLOOR INVENTORY</div><h1>Inventory</h1><p>{listTab === 'in-stock' ? 'For-sale units on hand. Click a unit to edit details, price, cost, package size, and photos.' : listTab === 'sold' ? (associateBrowseOnly ? 'Sold units by SKU.' : 'Sold units and what they sold for.') : listTab === 'defective' ? 'Not-for-sale units and anything graded Defective. These only need a brand.' : listTab === 'needs-check' ? 'Complete units with no channel checked yet. Open one and tick eBay, Amazon or TikTok Shop.' : listTab === 'unfinished' ? 'For-sale units missing a photo, price, or other required info.' : tab === 'left-store' ? 'Units that left the store without a sale: replacements sent to customers and items given away. Their cost counts against profit and expenses.' : tab === 'receive' ? 'Scan a UPC to look up product data, then receive with a real photo.' : tab === 'lookup-test' ? 'Read-only UPC accuracy test — Amazon vs UPCitemdb. Does not create inventory.' : tab === 'products' ? 'Shared UPC product database — edits stick for future scans. Price/condition stay on each unit.' : tab === 'measure-mat' ? 'Printable 50 mm scale mat for Receive photo measuring.' : ''}</p></div></header>
    <div className="inventory-tabs">
      {[...LIST_TABS, ...(associateBrowseOnly ? [] : TOOL_TABS)].map(([id, text]) => <button type="button" key={id} className={(listTab ?? tab) === id ? 'active' : ''} onClick={() => pickTab(id)}>{text}</button>)}
    </div>
    {listTab === 'unfinished' && !associateBrowseOnly && (
      <div className="inventory-tabs report-tabs online-channel-tabs">
        <button type="button" className={!queue ? 'active' : ''} onClick={() => { setOffset(0); setList(null); onAttentionSection('all'); }}>All unfinished</button>
        {ATTENTION_SECTIONS.map(([id, text]) => <button type="button" key={id} className={queue === id ? 'active' : ''} onClick={() => onAttentionSection(id)}>{text}{counts[id] !== undefined && <small>{counts[id]}</small>}</button>)}
      </div>
    )}
    {!listTab && tab === 'left-store' ? <DispositionsPanel client={client} money={money} stamp={stamp} kind={null} title="Replaced and given away" hint="Undo puts a unit back in stock and reverses its cost and commission effects." refreshKey={refresh} onChanged={() => { setRefresh(n => n + 1); onCostChanged(); }} /> : !listTab && tab === 'missing-category' ? <CategoryPanel client={client} storeId={storeId} /> : !listTab && tab === 'lookup-test' ? <LookupTestPage accessToken={accessToken} /> : !listTab && tab === 'products' ? <FloorProductsPage client={client} /> : !listTab && tab === 'measure-mat' ? <MarkerMatPage /> : !listTab && tab === 'receive' ? <ReceivePanel client={client} storeId={storeId} accessToken={accessToken} onSaved={() => setRefresh(n => n + 1)} /> : queue ? <NeedsAttentionPanel client={client} storeId={storeId} money={money} stamp={stamp} section={queue} onCostChanged={() => { setRefresh(n => n + 1); onCostChanged(); }} /> : <>
    <div className="inventory-controls">
      <label>Search<input type="search" placeholder="SKU, brand, model or title" value={query} onChange={e => change(() => setQuery(e.target.value))} /></label>
      {listTab === 'in-stock' && <label>Status<select value={status} onChange={e => change(() => setStatus(e.target.value))}>
        <option value="in_stock">In stock</option><option value="listed">Listed online</option>
        <option value="reserved">Reserved</option><option value="repair">Repair</option>
        <option value="delisted">Delisted listing</option><option value="all">All statuses</option><option value="voided">Voided</option>
        <option value="scrapped">Scrapped</option><option value="lost">Lost</option>
      </select></label>}
      <label>Location<select value={location} onChange={e => change(() => setLocation(e.target.value))}>
        <option value="all">All locations</option><option value="unassigned">Unassigned stock</option>
        {locationOptions.map((item) => <option key={item.code} value={item.code}>{item.code}</option>)}
      </select></label>
      <label>Sort<select value={sort} onChange={e => change(() => setSort(e.target.value))}>
        <option value="sku">SKU (newest)</option>{!hideMoney && <option value="price">Price (low to high)</option>}
        <option value="date">{listTab === 'sold' ? 'Date sold (newest)' : 'Date added (newest)'}</option>
      </select></label>
    </div>
    {error && <div className="alert" role="alert">{error}</div>}
    <div className="stats inventory-stats inventory-stats-one">
      <div className="stat"><span>Units</span><strong>{list?.totals.piece_count ?? total}</strong></div>
      {list?.totals.piece_count != null && list.totals.piece_count !== total && <div className="stat"><span>Items (rows)</span><strong>{total}</strong></div>}
    </div>
    <section className="panel inventory-panel">
      {loading && <p className="hint">Loading inventory…</p>}
      {!loading && list?.items.length === 0 && <div className="empty">{listTab === 'in-stock' && query.trim() ? 'No for-sale units match. Not-for-sale and defective units are under Defective.' : 'No units match this filter.'}</div>}
      {list?.items.map(u => { const actions = showDispositionButtons({ isAdmin: canDelete, associateBrowseOnly, inStock: listTab === 'in-stock' && u.state === 'available' });
      const rowButton = <button type="button" className="inventory-row" key={u.sku} disabled={hideMoney} onClick={() => { if (!hideMoney) setSelected(u.sku); }}>
        <span className="inventory-photo">{u.photo_path && urls[u.photo_path] ? <img loading="lazy" src={urls[thumb(u.photo_path)] || urls[u.photo_path]} onError={e => { const fallback = urls[u.photo_path!]; if (e.currentTarget.src !== fallback) e.currentTarget.src = fallback; }} alt="" /> : 'No photo'}</span>
        <span className="inventory-identity"><strong>{name(u)}</strong><small>SKU {u.sku}{u.title && u.title !== name(u) ? ` · ${u.title}` : ''}</small></span>
        <span className="inventory-meta">{u.condition || 'No grade'}<small>{u.not_for_sale ? 'Not for sale' : listTab === 'sold' && u.sold_at ? `Sold ${stamp(u.sold_at)}` : label(u.state)}</small>{listTab === 'unfinished' && !!u.missing?.length && <small className="inventory-missing">{missingText(u.missing)}</small>}</span>
        <span className="inventory-location">{u.locations || 'Unassigned'}</span>
        {hideMoney ? <span className="inventory-money" /> : listTab === 'sold'
          ? <span className="inventory-money"><strong>{u.sold_price_cents == null ? '—' : money(u.sold_price_cents)}</strong><small>{u.acquisition_cost_cents == null ? 'Cost missing' : `Cost ${money(u.acquisition_cost_cents)}`}</small></span>
          : <span className="inventory-money"><strong>{u.ask_cents == null ? 'No price' : money(u.ask_cents)}</strong>{!associateBrowseOnly && <small>Cost {u.acquisition_cost_cents == null ? 'missing' : money(u.acquisition_cost_cents)}</small>}</span>}
      </button>;
      return actions ? <div className="inventory-row-wrap" key={u.sku}>{rowButton}<div className="inventory-row-actions"><DispositionButtons client={client} sku={u.sku} money={money} stamp={stamp} className="secondary" onDone={() => { setRefresh(n => n + 1); onCostChanged(); }} /></div></div> : rowButton; })}
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
      canDelete={canDelete}
      onClose={() => setSelected(null)}
      onSaved={(unit) => {
        setDetail(d => d ? { ...d, unit } : d);
        setRefresh(n => n + 1);
        onCostChanged();
      }}
      onPhotosChanged={() => setDetailKey(k => k + 1)}
      onDeleted={() => {
        setSelected(null);
        setDetail(null);
        setRefresh(n => n + 1);
        onCostChanged();
      }}
    />}
    {selected && !detail && <div className="inventory-backdrop"><section className="inventory-detail"><p>Loading…</p></section></div>}
    </>}
  </>;
}
