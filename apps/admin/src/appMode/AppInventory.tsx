import { ReceiveGroupRow, type GroupedInventory } from '../ReceiveGroupRow';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttentionSection } from '../navigation';
import { ATTENTION_SECTIONS, NeedsAttentionPanel, useAttentionCounts } from '../NeedsAttentionPanel';
import { reviewReasonLabel } from '../inventoryReview';
import { shortError } from './shortError';
import { InventoryTotals } from '../InventoryTotals';
import { inventoryMissingText } from '../inventoryMissing';
import { INVENTORY_BUCKET_LABELS, inventoryBucketStatus, type InventoryBucket } from '../totalsMath';

/** Same stock subtabs as desktop Inventory. */
type Filter = 'in_stock' | 'sold' | 'unfinished' | 'needs_check' | 'no_location' | 'defective' | 'dns' | InventoryBucket;

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
const URL_CACHE_KEY = 'floor_inv_urls_v2';
const PAGE = 40;
/** Signed URLs are minted for 3600s; refresh a bit early. */
const URL_TTL_MS = 50 * 60 * 1000;

function thumb(path: string) {
  const parts = path.split('/');
  if (parts.length < 3 || parts[1] === 'archive' || parts[2] === 'web') return path;
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  return `${parts[0]}/${parts[1]}/web/400/${stem}.webp`;
}

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

function readUrlCache(scope: string): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(`${URL_CACHE_KEY}:${scope}`);
    if (!raw) return {};
    const pack = JSON.parse(raw) as { at: number; urls: Record<string, string> };
    if (!pack?.at || Date.now() - pack.at > URL_TTL_MS) return {};
    return pack.urls || {};
  } catch {
    return {};
  }
}

function writeUrlCache(scope: string, urls: Record<string, string>) {
  try {
    sessionStorage.setItem(`${URL_CACHE_KEY}:${scope}`, JSON.stringify({ at: Date.now(), urls }));
  } catch { /* quota */ }
}

function name(u: Row) {
  return [u.brand, u.model].filter(Boolean).join(' ') || u.title || 'Untitled';
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
  const [urls, setUrls] = useState<Record<string, string>>(() => readUrlCache(cacheScope));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [queue, setQueue] = useState<Exclude<AttentionSection, 'all'> | null>(null);
  const [queueRefresh, setQueueRefresh] = useState(0);
  const [noLocationCount, setNoLocationCount] = useState(0);
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
    return () => { active = false; };
  }, [client, storeId, refreshKey]);

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

  /** Sign storage paths; skip missing objects (web/400 often absent for fresh captures). */
  async function signPaths(paths: string[]) {
    const keys = [...new Set(paths.filter((p) => /^[0-9a-f-]{36}\//i.test(p) && !urlsRef.current[p]))];
    if (!keys.length) return {} as Record<string, string>;
    const out: Record<string, string> = {};
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const { data, error: e } = await client.storage.from('unit-photos').createSignedUrls(chunk, 3600);
      if (e) throw e;
      for (const row of data || []) {
        if (row?.path && row.signedUrl && !row.error) out[row.path] = row.signedUrl;
      }
    }
    return out;
  }

  function mergeUrls(extra: Record<string, string>) {
    if (!Object.keys(extra).length) return;
    setUrls((prev) => {
      const next = { ...prev, ...extra };
      writeUrlCache(cacheScope, next);
      return next;
    });
  }

  /**
   * Sign original photo paths for list previews.
   * Fresh captures usually have no web/400 derivative yet — createSignedUrls on missing
   * keys is slow (~2s) and returns no URL, which left every row stuck on "+".
   */
  async function signItemPhotos(items: Row[], apply: (urls: Record<string, string>) => void) {
    const originals = items.map((x) => x.photo_path).filter((p): p is string => Boolean(p));
    if (!originals.length) return;
    apply(await signPaths(originals).catch(() => ({})));
  }

  useEffect(() => {
    let alive = true;
    const apply = (extra: Record<string, string>) => {
      if (alive) mergeUrls(extra);
    };
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
          const status = filter === 'unfinished' ? 'all' : filter === 'no_location' ? 'in_stock' : filter in INVENTORY_BUCKET_LABELS ? inventoryBucketStatus(filter as InventoryBucket) : filter;
          const unfinished = filter === 'unfinished';
          const { data, error: e } = await client.rpc('receive_inventory_list', {
            p_query: query, p_status: status, p_unfinished: unfinished, p_sort:'sku',
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
    if (filter === 'sold') return `${pieces} units sold${rowsNote}`;
    if (filter === 'dns') return `${pieces} units DNS / Do not ship${rowsNote}`;
    if (filter === 'defective') return `${pieces} units defective / not for sale${rowsNote}`;
    return `${pieces} units in stock${rowsNote}`;
  }, [filter, total, pieces, rowsNote]);

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
      <div className="app-large-title"><h1>Inventory</h1></div>
      <label className="app-search">
        <span aria-hidden>⌕</span>
        <input
          type="search"
          placeholder="Search"
          value={query}
          enterKeyHint="search"
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      <InventoryTotals client={client} variant="app" refreshKey={refreshKey} selected={filter in INVENTORY_BUCKET_LABELS ? filter as InventoryBucket : undefined} onSelect={bucket => { setQuery(''); setFilterTab(bucket); setList(null); }} />
      <div className="app-segment" role="tablist">
        {([
          ['in_stock', 'In stock'],
          ['sold', 'Sold'],
          ['needs_check', 'Needs check'],
          ['no_location', `No location ${noLocationCount}`],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className={filter === id ? 'active' : ''}
            aria-selected={filter === id}
            onClick={() => setFilterTab(id)}
          >
            {label}
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

      {error && <p className="app-inline-error">{error}</p>}
      {loading && !list && <p className="app-footer-count">Loading…</p>}
      {loading && list ? <p className="app-footer-count">Updating…</p> : null}

      <div className="app-group">
        {(list?.items || []).map((u, idx) => {
          if(u.group_id && (u.group_total || 0) > 1) return <ReceiveGroupRow key={u.group_id} item={u} client={client} admin={fullAccess} money={money} onOpen={onOpen} searchQuery={query} onChanged={()=>{setList(null);setQueueRefresh(n=>n+1)}} />;
          const warn = filter === 'dns' ? null : needs(u);
          const missing = filter === 'not_ready' ? inventoryMissingText(u.missing || []) : null;
          const thumbPath = u.photo_path ? thumb(u.photo_path) : '';
          // Prefer small derivative when signed; otherwise the original (always exists when photo_path is set).
          const src = u.photo_path
            ? (thumbPath && urls[thumbPath]) || urls[u.photo_path] || ''
            : '';
          const bulkPick = filter === 'no_location' && noLocSelecting;
          const checked = noLocSelected.has(u.sku);
          return (
            <button type="button" className={`app-row${bulkPick && checked ? ' is-selected' : ''}`} key={u.sku} onClick={() => {
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
                {src ? (
                  <img
                    src={src}
                    alt=""
                    loading={idx < 12 ? 'eager' : 'lazy'}
                    decoding="async"
                    onError={(e) => {
                      // web/400 URL can 404 if Storage signed a missing key — swap to original once.
                      if (!u.photo_path || e.currentTarget.dataset.fallback === '1') return;
                      e.currentTarget.dataset.fallback = '1';
                      const original = urls[u.photo_path];
                      if (original && original !== e.currentTarget.src) {
                        e.currentTarget.src = original;
                        return;
                      }
                      void client.storage.from('unit-photos').createSignedUrl(u.photo_path, 3600).then(({ data }) => {
                        if (data?.signedUrl) {
                          mergeUrls({ [u.photo_path!]: data.signedUrl });
                          e.currentTarget.src = data.signedUrl;
                        }
                      });
                    }}
                  />
                ) : '+'}
              </span>
              <span className="app-row-text">
                <strong>{name(u)}</strong>
                <small>
                  {u.sku} · {u.not_for_sale ? 'Not for sale' : u.condition || 'No grade'}
                  {filter === 'sold' && u.sold_at ? <> · Sold {stamp(u.sold_at)}</> : null}
                  {(u.is_stocked || (u.qty_on_hand ?? 1) > 1) && <b className="stock-quantity-badge">×{filter === 'sold' ? (u.sold_qty ?? 0) : u.qty_on_hand}</b>}
                  {fullAccess && u.acquisition_cost_cents === null ? <> · <span className="warn">Cost missing</span></> : null}
                  {filter !== 'not_ready' && warn ? <> · <span className="warn">{warn}</span></> : null}
                </small>
              </span>
              {filter === 'sold'
                ? fullAccess && <span className="app-row-price">{u.sold_price_cents == null ? '—' : money(u.sold_price_cents)}</span>
                : <span className="app-row-price-stack">{missing && <small className="inventory-missing">{missing}</small>}<span className="app-row-price">{u.ask_cents == null ? '—' : money(u.ask_cents)}</span></span>}
              <span className="app-chevron" aria-hidden>›</span>
            </button>
          );
        })}
        {!loading && list && list.items.length === 0 && (
          <div className="app-empty-row">
            {error ? 'Couldn’t load inventory — reopen the tab to retry.' : 'Nothing matches this filter.'}
          </div>
        )}
      </div>

      {noLocSelecting && noLocSelected.size > 0 && (
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

      <div className="app-footer-count">{footer}</div>
      {pageRows > PAGE && (
        <div className="app-actions" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <button type="button" disabled={offset + PAGE >= pageRows || loading} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      )}
    </div>
  );
}
