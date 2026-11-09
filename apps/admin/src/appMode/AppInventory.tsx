import { ReceiveGroupRow, type GroupedInventory } from '../ReceiveGroupRow';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { displayProductTitle } from '@floor/store';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttentionSection } from '../navigation';
import { ATTENTION_SECTIONS, NeedsAttentionPanel, useAttentionCounts } from '../NeedsAttentionPanel';
import { reviewReasonLabel } from '../inventoryReview';
import { shortError } from './shortError';
import { InventoryTotals } from '../InventoryTotals';
import { inventoryMissingText } from '../inventoryMissing';
import { INVENTORY_BUCKET_LABELS, inventoryBucketStatus, type InventoryBucket, type InventoryTotalsData } from '../totalsMath';
import { MissingCostList } from './MissingCostList';
import { hydratePhotoUrlCache, listThumbPathsFromOriginals, persistPhotoUrlCache, signPhotoUrls } from '../unitPhotos';
import { UnitListThumb } from '../UnitListThumb';

/** Same stock subtabs as desktop Inventory. */
type Filter = 'in_stock' | 'sold' | 'unfinished' | 'needs_check' | 'no_location' | 'missing_cost' | 'ebay_fix' | 'defective' | 'dns' | 'never_list' | InventoryBucket;

type EbayFix = { count: number; items: { sku: string; title: string; issue: string }[] };

type Row = GroupedInventory & {
  sku: string;
  brand: string;
  model: string;
  title: string;
  condition: string | null;
  ask_cents: number | null;
  state: string;
  qty_on_hand?: number; is_stocked?: boolean; sold_qty?: number;
  photo_path: string | null;
  photo_count: number;
  package_weight_lb?: number | null;
  not_for_sale?: boolean;
  defective?: boolean;
  missing?: string[];
  sold_at?: string | null;
  sold_price_cents?: number | null;
  acquisition_cost_cents?: number | null;
};

type List = { items: Row[]; totals: { unit_count: number; row_count?: number; piece_count?: number } };

type Props = {
  client: SupabaseClient;
  storeId: string;
  /** Admin / owner / manager. Clerks get no fix queues, and the server sends them no sold prices. */
  fullAccess: boolean;
  staffMode?: boolean;
  money: (n: number) => string;
  stamp: (s: string) => string;
  onOpen: (sku: string, missingFields?: string[]) => void;
  refreshKey?: number;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
};

const CACHE_PREFIX = 'floor_inv_cache_v6_';
const PAGE = 40;

function cacheKey(scope: string, filter: Filter, query: string, offset: number) {
  return `${CACHE_PREFIX}${scope}:${filter}:${query.trim().toLowerCase()}:${offset}`;
}

function readCache(scope: string, filter: Filter, query: string, offset: number): List | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(scope, filter, query, offset));
    if (!raw) return null;
    return JSON.parse(raw) as List;
  } catch {
    return null;
  }
}

function writeCache(scope: string, filter: Filter, query: string, offset: number, list: List) {
  try {
    sessionStorage.setItem(cacheKey(scope, filter, query, offset), JSON.stringify(list));
  } catch { /* quota */ }
}

function name(u: Row) {
  return displayProductTitle({ title: u.title, brand: u.brand, model: u.model });
}

const MISSING_LABEL: Record<string, string> = {
  photo: 'No photos', price: 'No price', brand: 'No brand', condition: 'No condition', category: 'No category',
  upc: 'No UPC', spec: 'Package size for shipping', model: 'No model', specifics: 'eBay item specifics', description: 'No description',
};

const missingCostRank = (u: Row) => u.acquisition_cost_cents == null ? (u.state === 'sold' ? 0 : 1) : 2;

function needs(u: Row): string | null {
  // Not-for-sale units only ever need a brand.
  if (u.not_for_sale) return u.brand?.trim() ? null : 'No brand';
  if (u.missing) {
    const review = u.missing.find((k) => reviewReasonLabel(k));
    if (review) return reviewReasonLabel(review);
    const first = u.missing.find((k) => MISSING_LABEL[k] || reviewReasonLabel(k));
    if (first) return MISSING_LABEL[first] || reviewReasonLabel(first);
  }
  if (u.state === 'sold' || u.defective) return null;
  if (!u.photo_count) return 'No photos';
  if (u.ask_cents == null) return 'No price';
  if (u.package_weight_lb == null || Number(u.package_weight_lb) <= 0) return 'Needs weight';
  return null;
}

export function AppInventory({ client, storeId, fullAccess, staffMode = false, money, stamp, onOpen, scrollRef, refreshKey = 0 }: Props) {
  const cacheScope = `${storeId}:${staffMode ? 'staff' : 'admin'}`;
  const [filter, setFilter] = useState<Filter>('in_stock');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<List | null>(() => readCache(cacheScope, 'in_stock', '', 0));
  const [urls, setUrls] = useState<Record<string, string>>(() => {
    hydratePhotoUrlCache(cacheScope);
    return {};
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [queue, setQueue] = useState<Exclude<AttentionSection, 'all'> | null>(null);
  const [queueRefresh, setQueueRefresh] = useState(0);
  const [noLocationCount, setNoLocationCount] = useState(0);
  const [cardTotals, setCardTotals] = useState<InventoryTotalsData | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tabRowRef = useRef<HTMLDivElement>(null);
  const [missingCostCount, setMissingCostCount] = useState<number | null>(null);
  const [ebayFix, setEbayFix] = useState<EbayFix | null>(null);
  const [noLocSelecting, setNoLocSelecting] = useState(false);
  const [noLocSelected, setNoLocSelected] = useState<Set<string>>(() => new Set());
  const [noLocBins, setNoLocBins] = useState<string[]>([]);
  const [noLocBin, setNoLocBin] = useState('');
  const [noLocBulkBusy, setNoLocBulkBusy] = useState(false);
  const counts = useAttentionCounts(client, fullAccess && filter === 'unfinished', queueRefresh);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;
  useEffect(() => {
    let active = true;
    void client.rpc('portal_unassigned_inventory_count').then(({ data }) => {
      if (active && typeof data === 'number') setNoLocationCount(data);
    });
    if (fullAccess) {
      void Promise.all([
        client.rpc('receive_inventory_list', { p_query: '', p_status: 'in_stock', p_unfinished: false, p_sort: 'sku', p_offset: 0, p_limit: 1, p_location: 'all' }),
        client.rpc('receive_inventory_list', { p_query: '', p_status: 'sold', p_unfinished: false, p_sort: 'sku', p_offset: 0, p_limit: 1, p_location: 'all' }),
      ]).then(([stock, sold]) => {
        if (!active) return;
        const stockMissing = (stock.data as { totals?: { missing_cost?: number | null } } | null)?.totals?.missing_cost;
        const soldMissing = (sold.data as { totals?: { missing_cost?: number | null } } | null)?.totals?.missing_cost;
        if (typeof stockMissing === 'number' && typeof soldMissing === 'number') setMissingCostCount(stockMissing + soldMissing);
      });
    }
    return () => { active = false; };
  }, [client, storeId, refreshKey, fullAccess]);

  useEffect(() => {
    if (filter !== 'no_location') {
      setNoLocSelecting(false);
      setNoLocSelected(new Set());
      return;
    }
    let active = true;
    void client.rpc('portal_bay_list').then(({ data, error: e }) => {
      if (!active || e) return;
      const codes = ((data?.locations || []) as { code: string }[]).map((row) => row.code).sort();
      setNoLocBins(codes);
    });
    return () => { active = false; };
  }, [client, filter]);

  async function bulkAssignNoLocation() {
    const skus = [...noLocSelected];
    const bin = noLocBin.trim();
    if (!skus.length || !bin) return;
    setNoLocBulkBusy(true);
    setError('');
    try {
      const { data, error: e } = await client.rpc('portal_bulk_assign_unassigned', { p_skus: skus, p_to: bin });
      if (e) throw e;
      const summary = data as { assigned?: number; skipped?: number; failed?: unknown[] };
      setNoLocSelected(new Set());
      setNoLocSelecting(false);
      setList(null);
      setOffset(0);
      void client.rpc('portal_unassigned_inventory_count').then(({ data: count }) => {
        if (typeof count === 'number') setNoLocationCount(count);
      });
      if ((summary.failed as unknown[])?.length) {
        setError(`Assigned ${summary.assigned ?? 0}; ${(summary.failed as unknown[]).length} failed.`);
      }
    } catch (err) {
      setError(shortError(String((err as Error).message || err)));
    } finally {
      setNoLocBulkBusy(false);
    }
  }

  function mergeUrls(extra: Record<string, string>) {
    if (!Object.keys(extra).length) return;
    setUrls((prev) => {
      const next = { ...prev, ...extra };
      persistPhotoUrlCache(cacheScope, next);
      return next;
    });
  }

  async function signItemPhotos(items: Row[], apply: (urls: Record<string, string>) => void) {
    const need = listThumbPathsFromOriginals(items.map((x) => x.photo_path)).filter((p) => !urlsRef.current[p]);
    if (!need.length) return;
    apply(await signPhotoUrls(client, need).catch(() => ({})));
  }

  useEffect(() => {
    let alive = true;
    const apply = (extra: Record<string, string>) => {
      if (alive) mergeUrls(extra);
    };
    if (filter === 'missing_cost' || filter === 'ebay_fix') {
      setLoading(false);
      return;
    }
    const cached = readCache(cacheScope, filter, query, offset);
    if (cached) {
      setList(cached);
      // Warm cache: start signing immediately — don't wait on the revalidate RPC.
      void signItemPhotos(cached.items, apply);
    }

    const t = setTimeout(() => {
      // Only show the full-page spinner when we have nothing to paint.
      if (!cached) setLoading(true);
      setError('');
      void (async () => {
        try {
          const status = filter === 'unfinished' ? 'all' : filter === 'no_location' ? 'in_stock' : filter === 'never_list' ? 'inventory_never_list' : filter in INVENTORY_BUCKET_LABELS ? inventoryBucketStatus(filter as InventoryBucket) : filter;
          const unfinished = filter === 'unfinished';
          const { data, error: e } = await client.rpc('receive_inventory_list', {
            p_query: query, p_status: status, p_unfinished: unfinished,
            p_sort: staffMode && filter === 'sold' ? 'date' : 'sku',
            p_offset:offset,p_limit:PAGE,p_location:filter==='no_location'?'unassigned':'all',
          });
          if (e) throw e;
          const next = data as List;
          if (!alive) return;
          if (filter === 'no_location') next.items.sort((a, b) => missingCostRank(a) - missingCostRank(b) || Number(b.state === 'reserved') - Number(a.state === 'reserved') || Number(b.state === 'sold') - Number(a.state === 'sold') || Number(b.sku) - Number(a.sku));
          setList(next);
          writeCache(cacheScope, filter, query, offset, next);
          setLoading(false);
          await signItemPhotos(next.items, apply);
        } catch (err) {
          if (!alive) return;
          setError(shortError(err));
          if (!cached) setList({ items: [], totals: { unit_count: 0 } });
          setLoading(false);
        }
      })();
    }, query.trim() ? 180 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, filter, query, offset, staffMode, cacheScope, refreshKey, queueRefresh]);

  useEffect(() => {
    let alive = true;
    void client.rpc('portal_ebay_needs_fix').then(({ data, error: e }) => {
      if (!alive) return;
      if (e) setError(e.message);
      else setEbayFix((data || { count: 0, items: [] }) as EbayFix);
    });
    return () => { alive = false; };
  }, [client, refreshKey]);

  const total = list?.totals.unit_count ?? 0;
  // Physical pieces (a row of 12 bottles counts 12); falls back to rows until the DB returns piece_count.
  const pageRows = list?.totals.row_count ?? total;
  const pieces = list?.totals.piece_count ?? total;
  const rowsNote = pieces !== total ? ` (${total} ${total === 1 ? 'item' : 'items'})` : '';
  const footer = useMemo(() => {
    if (filter in INVENTORY_BUCKET_LABELS) return `${pieces} units · ${INVENTORY_BUCKET_LABELS[filter as InventoryBucket]}${rowsNote}`;
    if (filter === 'unfinished') return `${pieces} units unfinished${rowsNote}`;
    if (filter === 'needs_check') return `${pieces} units need to be checked${rowsNote}`;
    if (filter === 'no_location') return `${pieces} in-stock units need a location${rowsNote}`;
    if (filter === 'missing_cost') return `${missingCostCount ?? 0} units missing a cost`;
    if (filter === 'ebay_fix') return `${ebayFix?.count ?? 0} need an eBay fix`;
    if (filter === 'sold') return `${pieces} units sold${rowsNote}`;
    if (filter === 'dns') return `${pieces} units DNS / Do not ship${rowsNote}`;
    if (filter === 'defective') return `${pieces} units defective / not for sale${rowsNote}`;
    return `${pieces} units in stock${rowsNote}`;
  }, [filter, total, pieces, rowsNote, missingCostCount, ebayFix?.count]);

  function setFilterTab(next: Filter) {
    setFilter(next);
    setQueue(null);
    setOffset(0);
    const hit = readCache(cacheScope, next, query, 0);
    setList(hit);
  }

  if (queue) {
    return (
      <div className="app-stack">
        <div className="app-nav">
          <button type="button" onClick={() => { setQueue(null); setQueueRefresh((n) => n + 1); }}>‹ Unfinished</button>
          <div className="app-nav-title">{ATTENTION_SECTIONS.find(([id]) => id === queue)?.[1]}</div>
          <button type="button" style={{ visibility: 'hidden' }}>·</button>
        </div>
        <div className="app-embed-soft">
          <NeedsAttentionPanel client={client} storeId={storeId} money={money} stamp={stamp} section={queue} onCostChanged={() => undefined} />
        </div>
      </div>
    );
  }


  return (
    <div ref={scrollRef as React.RefObject<HTMLDivElement>}>
      <div className="app-large-title app-title-row"><h1>Inventory</h1><button type="button" className="app-title-link" onClick={() => searchRef.current?.focus()}>Scan</button></div>
      <label className="app-search">
        <span aria-hidden>⌕</span>
        <input
          ref={searchRef}
          type="search"
          placeholder="Search SKU, title, UPC"
          value={query}
          enterKeyHint="search"
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      <InventoryTotals client={client} variant="app" refreshKey={refreshKey} plain={staffMode} onTotals={setCardTotals} selected={filter in INVENTORY_BUCKET_LABELS ? filter as InventoryBucket : undefined} onSelect={bucket => { setQuery(''); setFilterTab(bucket); setList(null); }} />
      <div className="app-segment app-segment-scroll" role="tablist" ref={tabRowRef}>
        {((staffMode ? [
          ['in_stock', 'In stock', null],
          ['sold', 'Sold', null],
          ['ebay_fix', 'Needs eBay fix', ebayFix?.count],
        ] : [
          ['in_stock', 'In stock', null],
          ['listed', 'Listed', cardTotals?.listed],
          ['not_ready', 'Not ready', cardTotals?.not_ready],
          ['sold', 'Sold', null],
          ['needs_check', 'Needs check', null],
          ['no_location', 'No location', noLocationCount],
          ['dns', 'DNS', cardTotals?.dns],
          ['defective', 'Defective', cardTotals?.defective],
          ['never_list', 'Never list', cardTotals?.never_list],
          ['ebay_fix', 'Needs eBay fix', ebayFix?.count],
          ...(fullAccess ? [['missing_cost', 'Missing cost', missingCostCount] as const] : []),
        ]) as [Filter, string, number | null | undefined][]).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={filter === id ? 'active' : ''}
            aria-selected={filter === id}
            ref={el => { if (filter === id && el) el.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }}
            onClick={() => setFilterTab(id)}
          >
            {label}{count != null ? <> <strong className={id === 'not_ready' ? 'inv-tab-alert' : undefined}>{count}</strong></> : null}
          </button>
        ))}
      </div>

      {filter === 'no_location' && (
        <div className="app-actions" style={{ marginBottom: 8 }}>
          <button type="button" className="secondary" onClick={() => { setNoLocSelecting((v) => !v); setNoLocSelected(new Set()); }}>
            {noLocSelecting ? 'Cancel select' : 'Select items'}
          </button>
        </div>
      )}

      {filter in INVENTORY_BUCKET_LABELS && <p className="app-section-label">{INVENTORY_BUCKET_LABELS[filter as InventoryBucket]}</p>}
      {fullAccess && filter === 'unfinished' && (
        <>
          <p className="app-section-label">Fix by field</p>
          <div className="app-group">
            {ATTENTION_SECTIONS.map(([id, label]) => (
              <button key={id} type="button" className="app-more-link" onClick={() => setQueue(id)}>
                <span className="app-more-left">{label}</span>
                <span className="app-more-right">
                  <span className="warn">{counts[id] ?? '…'}</span>
                  <span className="app-chevron">›</span>
                </span>
              </button>
            ))}
          </div>
          <p className="app-section-label">Unfinished items</p>
        </>
      )}

      {filter === 'ebay_fix' && error && <p className="app-inline-error">{error}</p>}
      {filter === 'ebay_fix' && (
        <div className="app-group">
          {(ebayFix?.items || []).filter((row) => {
            const q = query.trim().toLowerCase();
            return !q || row.title.toLowerCase().includes(q) || row.sku.toLowerCase().includes(q) || row.issue.toLowerCase().includes(q);
          }).map((row) => (
            <button key={row.sku} type="button" className="app-row" onClick={() => onOpen(row.sku)}>
              <span className="app-row-text">
                <strong className="app-row-title">{row.title}</strong>
                <small className="app-sku-line"><span className="lbl">SKU</span> <strong>{row.sku}</strong></small>
                <small className="warn">{row.issue}</small>
              </span>
            </button>
          ))}
          {ebayFix && ebayFix.items.length === 0 && <div className="app-empty-row">Nothing needs an eBay fix.</div>}
        </div>
      )}

      {filter === 'missing_cost' && fullAccess && (
        <MissingCostList
          client={client}
          query={query}
          stamp={stamp}
          refreshKey={refreshKey}
          onOpen={sku => onOpen(sku)}
          onCount={setMissingCostCount}
        />
      )}

      {filter !== 'missing_cost' && filter !== 'ebay_fix' && error && <p className="app-inline-error">{error}</p>}
      {filter !== 'missing_cost' && filter !== 'ebay_fix' && loading && !list && <p className="app-footer-count">Loading…</p>}
      {filter !== 'missing_cost' && filter !== 'ebay_fix' && loading && list ? <p className="app-footer-count">Updating…</p> : null}

      {filter !== 'missing_cost' && filter !== 'ebay_fix' && <div className="app-group">
        {(list?.items || []).map((u, idx, arr) => {
          if(u.group_id && (u.group_total || 0) > 1 && !staffMode) return <ReceiveGroupRow key={u.group_id} item={u} client={client} admin={fullAccess} money={money} onOpen={onOpen} searchQuery={query} onChanged={()=>{setList(null);setQueueRefresh(n=>n+1)}} />;
          const warn = filter === 'dns' ? null : needs(u);
          const missing = filter === 'not_ready' ? inventoryMissingText(u.missing || []).replace(/^Missing: /, 'Missing ').replace(/, /g, ' · Missing ') : null;
          const bay = (u as Row & { locations?: string }).locations?.split(',')[0]?.trim();
          const bulkPick = filter === 'no_location' && noLocSelecting;
          const checked = noLocSelected.has(u.sku);
          const soldDay = u.sold_at ? new Date(u.sold_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
          const prevDay = arr[idx - 1]?.sold_at ? new Date(arr[idx - 1].sold_at as string).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
          return (
            <Fragment key={u.sku}>
            {staffMode && filter === 'sold' && soldDay !== prevDay && <p className="app-day-head">{soldDay || 'Unknown day'}</p>}
            <button type="button" className={`app-row${bulkPick && checked ? ' is-selected' : ''}`} onClick={() => {
              if (bulkPick) {
                setNoLocSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(u.sku)) next.delete(u.sku);
                  else next.add(u.sku);
                  return next;
                });
                return;
              }
              onOpen(u.sku, filter === 'not_ready' ? u.missing : undefined);
            }}>
              {bulkPick && <span className="app-row-check" aria-hidden>{checked ? '☑' : '☐'}</span>}
              <span className="app-thumb">
                <UnitListThumb
                  client={client}
                  photoPath={u.photo_path}
                  urls={urls}
                  onUrl={(p, url) => mergeUrls({ [p]: url })}
                  eager={idx < 12}
                  placeholder="+"
                />
              </span>
              <span className="app-row-text">
                <strong className={staffMode ? 'app-row-title' : undefined}>{name(u)}</strong>
                {staffMode ? (
                  <>
                    <small className="app-sku-line"><span className="lbl">SKU</span> <strong>{u.sku}</strong></small>
                    {filter !== 'sold' && <small className="app-row-cond">{u.not_for_sale ? 'Not for sale' : u.condition || 'No grade'}{bay ? ` · ${bay}` : ''}</small>}
                  </>
                ) : (
                  <small>
                    {u.sku} · {u.not_for_sale ? 'Not for sale' : u.condition || 'No grade'}{bay ? ` · ${bay}` : ''}
                    {filter === 'sold' && u.sold_at ? <> · Sold {stamp(u.sold_at)}</> : null}
                    {(u.is_stocked || (u.qty_on_hand ?? 1) > 1) && <b className="stock-quantity-badge">×{filter === 'sold' ? (u.sold_qty ?? 0) : u.qty_on_hand}</b>}
                    {fullAccess && u.acquisition_cost_cents === null ? <> · <span className="warn">Cost missing</span></> : null}
                    {filter !== 'not_ready' && warn ? <> · <span className="warn">{warn}</span></> : null}
                  </small>
                )}
                {missing && !staffMode && <small className="inventory-missing inv-missing-line">{missing}</small>}
              </span>
              {staffMode && filter === 'sold' && u.sold_at
                ? <span className="app-row-when">{new Date(u.sold_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                : filter === 'sold'
                ? fullAccess && <span className="app-row-price">{u.sold_price_cents == null ? '—' : money(u.sold_price_cents)}</span>
                : <span className="app-row-price">{u.ask_cents == null ? '—' : money(u.ask_cents)}</span>}
              {!staffMode && <span className="app-chevron" aria-hidden>›</span>}
            </button>
            </Fragment>
          );
        })}
        {!loading && list && list.items.length === 0 && (
          <div className="app-empty-row">
            {error ? 'Couldn’t load inventory — reopen the tab to retry.' : 'Nothing matches this filter.'}
          </div>
        )}
      </div>}

      {filter !== 'missing_cost' && filter !== 'ebay_fix' && noLocSelecting && noLocSelected.size > 0 && (
        <div className="app-bulk-bar">
          <select value={noLocBin} onChange={(e) => setNoLocBin(e.target.value)} aria-label="Assign location">
            <option value="">Choose location…</option>
            {noLocBins.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
          <button type="button" disabled={noLocBulkBusy || !noLocBin.trim()} onClick={() => void bulkAssignNoLocation()}>
            {noLocBulkBusy ? 'Assigning…' : 'Assign location'}
          </button>
          <span>{noLocSelected.size} selected</span>
        </div>
      )}

      {filter !== 'missing_cost' && filter !== 'ebay_fix' && <div className="app-footer-count">{footer}</div>}
      {filter === 'ebay_fix' && <div className="app-footer-count">{footer}</div>}
      {filter !== 'missing_cost' && filter !== 'ebay_fix' && pageRows > PAGE && (
        <div className="app-actions" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <button type="button" disabled={offset + PAGE >= pageRows || loading} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      )}
    </div>
  );
}
