import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttentionSection } from '../navigation';
import { ATTENTION_SECTIONS, NeedsAttentionPanel, useAttentionCounts } from '../NeedsAttentionPanel';
import { reviewReasonLabel } from '../inventoryReview';
import { CategoryPanel } from '../CategoryPanel';
import { shortError } from './shortError';
import { InventoryTotals } from '../InventoryTotals';

/** Same five subtabs as desktop Inventory. Unfinished replaces the old More → Needs attention. */
type Filter = 'in_stock' | 'sold' | 'unfinished' | 'needs_check' | 'defective';

type Row = {
  sku: string;
  brand: string;
  model: string;
  title: string;
  condition: string | null;
  ask_cents: number | null;
  state: string;
  photo_path: string | null;
  photo_count: number;
  package_weight_lb?: number | null;
  not_for_sale?: boolean;
  defective?: boolean;
  missing?: string[];
  sold_at?: string | null;
  sold_price_cents?: number | null;
};

type List = { items: Row[]; totals: { unit_count: number; piece_count?: number } };

type Props = {
  client: SupabaseClient;
  storeId: string;
  /** Admin / owner / manager. Clerks get no fix queues, and the server sends them no sold prices. */
  fullAccess: boolean;
  staffMode?: boolean;
  money: (n: number) => string;
  stamp: (s: string) => string;
  onOpen: (sku: string) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
};

const CACHE_PREFIX = 'floor_inv_cache_v3_';
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
  upc: 'No UPC', spec: 'Needs weight', model: 'No model',
};

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

export function AppInventory({ client, storeId, fullAccess, staffMode = false, money, stamp, onOpen, scrollRef }: Props) {
  const cacheScope = `${storeId}:${staffMode ? 'staff' : 'admin'}`;
  const [filter, setFilter] = useState<Filter>('in_stock');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<List | null>(() => readCache(cacheScope, 'in_stock', '', 0));
  const [urls, setUrls] = useState<Record<string, string>>(() => readUrlCache(cacheScope));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unfinishedCount, setUnfinishedCount] = useState<number | null>(null);
  const [queue, setQueue] = useState<Exclude<AttentionSection, 'all'> | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [queueRefresh, setQueueRefresh] = useState(0);
  const counts = useAttentionCounts(client, fullAccess && filter === 'unfinished', queueRefresh);
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

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
          const status = filter === 'unfinished' ? 'all' : filter;
          const unfinished = filter === 'unfinished';
          const { data, error: e } = await client.rpc(staffMode ? 'staff_inventory_list' : 'portal_inventory_list', {
            p_query: query,
            p_status: status,
            p_unfinished: unfinished,
            p_sort: 'sku',
            p_offset: offset,
            p_limit: PAGE,
          });
          if (e) throw e;
          const next = data as List;
          if (!alive) return;
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
  }, [client, filter, query, offset, staffMode, cacheScope]);

  // Unfinished badge once — not after every list refresh.
  useEffect(() => {
    let alive = true;
    void client
      .rpc(staffMode ? 'staff_inventory_list' : 'portal_inventory_list', {
        p_query: '',
        p_status: 'all',
        p_unfinished: true,
        p_sort: 'sku',
        p_offset: 0,
        p_limit: 1,
      })
      .then(({ data }) => {
        if (alive && data) setUnfinishedCount((data as List).totals?.unit_count ?? 0);
      });
    return () => {
      alive = false;
    };
  }, [client, staffMode]);

  const total = list?.totals.unit_count ?? 0;
  // Physical pieces (a row of 12 bottles counts 12); falls back to rows until the DB returns piece_count.
  const pieces = list?.totals.piece_count ?? total;
  const rowsNote = pieces !== total ? ` (${total} ${total === 1 ? 'item' : 'items'})` : '';
  const footer = useMemo(() => {
    if (filter === 'unfinished') return `${pieces} units unfinished${rowsNote}`;
    if (filter === 'needs_check') return `${pieces} units need to be checked${rowsNote}`;
    if (filter === 'sold') return `${pieces} units sold${rowsNote}`;
    if (filter === 'defective') return `${pieces} units defective / not for sale${rowsNote}`;
    const u = unfinishedCount;
    return u == null ? `${pieces} units in stock${rowsNote}` : `${pieces} units in stock${rowsNote} · ${u} unfinished`;
  }, [filter, total, pieces, rowsNote, unfinishedCount]);

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

  if (categoryOpen) return <div className="app-stack"><div className="app-nav">
    <button type="button" onClick={() => setCategoryOpen(false)}>‹ Inventory</button>
    <div className="app-nav-title">Missing Category</div><span />
  </div><div className="app-embed-soft"><CategoryPanel client={client} storeId={storeId} /></div></div>;

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
      <InventoryTotals client={client} variant="app" />
      <div className="app-segment" role="tablist">
        {([
          ['in_stock', 'In stock'],
          ['sold', 'Sold'],
          ['unfinished', 'Unfinished'],
          ['needs_check', 'Needs check'],
          ['defective', 'Defective'],
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
      {fullAccess && <div className="app-group"><button type="button" className="app-more-link" onClick={() => setCategoryOpen(true)}>
        <span className="app-more-left">Missing Category</span><span className="app-chevron">›</span>
      </button></div>}

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
          const warn = needs(u);
          const thumbPath = u.photo_path ? thumb(u.photo_path) : '';
          // Prefer small derivative when signed; otherwise the original (always exists when photo_path is set).
          const src = u.photo_path
            ? (thumbPath && urls[thumbPath]) || urls[u.photo_path] || ''
            : '';
          return (
            <button type="button" className="app-row" key={u.sku} onClick={() => onOpen(u.sku)}>
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
                  {warn ? <> · <span className="warn">{warn}</span></> : null}
                </small>
              </span>
              {filter === 'sold'
                ? fullAccess && <span className="app-row-price">{u.sold_price_cents == null ? '—' : money(u.sold_price_cents)}</span>
                : <span className="app-row-price">{u.ask_cents == null ? '—' : money(u.ask_cents)}</span>}
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

      <div className="app-footer-count">{footer}</div>
      {total > PAGE && (
        <div className="app-actions" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
          <button type="button" disabled={offset + PAGE >= total || loading} onClick={() => setOffset(offset + PAGE)}>Next</button>
        </div>
      )}
    </div>
  );
}
