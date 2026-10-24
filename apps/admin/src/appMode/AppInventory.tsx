import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Filter = 'in_stock' | 'unfinished' | 'listed' | 'sold';

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
};

type List = { items: Row[]; totals: { unit_count: number } };

type InvStats = {
  total_active_inventory: number;
  sold_inventory: number;
  ebay: number;
  amazon: number;
  depop: number;
  tiktok: number;
  do_not_list: number;
};

type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
  onOpen: (sku: string) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
};

const CACHE_PREFIX = 'floor_inv_cache_v1_';
const URL_CACHE_KEY = 'floor_inv_urls_v1';
const PAGE = 40;
/** Signed URLs are minted for 3600s; refresh a bit early. */
const URL_TTL_MS = 50 * 60 * 1000;

function thumb(path: string) {
  const parts = path.split('/');
  if (parts.length < 3 || parts[1] === 'archive' || parts[2] === 'web') return path;
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  return `${parts[0]}/${parts[1]}/web/400/${stem}.webp`;
}

function cacheKey(filter: Filter, query: string, offset: number) {
  return `${CACHE_PREFIX}${filter}:${query.trim().toLowerCase()}:${offset}`;
}

function readCache(filter: Filter, query: string, offset: number): List | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(filter, query, offset));
    if (!raw) return null;
    return JSON.parse(raw) as List;
  } catch {
    return null;
  }
}

function writeCache(filter: Filter, query: string, offset: number, list: List) {
  try {
    sessionStorage.setItem(cacheKey(filter, query, offset), JSON.stringify(list));
  } catch { /* quota */ }
}

function readUrlCache(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(URL_CACHE_KEY);
    if (!raw) return {};
    const pack = JSON.parse(raw) as { at: number; urls: Record<string, string> };
    if (!pack?.at || Date.now() - pack.at > URL_TTL_MS) return {};
    return pack.urls || {};
  } catch {
    return {};
  }
}

function writeUrlCache(urls: Record<string, string>) {
  try {
    sessionStorage.setItem(URL_CACHE_KEY, JSON.stringify({ at: Date.now(), urls }));
  } catch { /* quota */ }
}

function name(u: Row) {
  return [u.brand, u.model].filter(Boolean).join(' ') || u.title || 'Untitled';
}

function needs(u: Row): string | null {
  if (!u.photo_count) return 'No photos';
  if (u.ask_cents == null) return 'No price';
  if (u.package_weight_lb == null || Number(u.package_weight_lb) <= 0) return 'Needs weight';
  return null;
}

export function AppInventory({ client, money, onOpen, scrollRef }: Props) {
  const [filter, setFilter] = useState<Filter>('in_stock');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [list, setList] = useState<List | null>(() => readCache('in_stock', '', 0));
  const [urls, setUrls] = useState<Record<string, string>>(() => readUrlCache());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unfinishedCount, setUnfinishedCount] = useState<number | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<InvStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState('');
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
      writeUrlCache(next);
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
    const cached = readCache(filter, query, offset);
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
          const status = filter === 'unfinished' ? 'in_stock' : filter === 'listed' ? 'listed' : filter;
          const unfinished = filter === 'unfinished';
          const { data, error: e } = await client.rpc('portal_inventory_list', {
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
          writeCache(filter, query, offset, next);
          setLoading(false);
          await signItemPhotos(next.items, apply);
        } catch (err) {
          if (!alive) return;
          setError(err instanceof Error ? err.message : String(err));
          if (!cached) setList({ items: [], totals: { unit_count: 0 } });
          setLoading(false);
        }
      })();
    }, query.trim() ? 180 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, filter, query, offset]);

  // Unfinished badge once — not after every list refresh.
  useEffect(() => {
    let alive = true;
    void client
      .rpc('portal_inventory_list', {
        p_query: '',
        p_status: 'in_stock',
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
  }, [client]);

  const total = list?.totals.unit_count ?? 0;
  const footer = useMemo(() => {
    if (filter === 'unfinished') return `${total} unfinished`;
    if (filter === 'sold') return `${total} sold`;
    if (filter === 'listed') return `${total} listed`;
    const u = unfinishedCount;
    return u == null ? `${total} in stock` : `${total} in stock · ${u} unfinished`;
  }, [filter, total, unfinishedCount]);

  function setFilterTab(next: Filter) {
    setFilter(next);
    setOffset(0);
    const hit = readCache(next, query, 0);
    setList(hit);
  }

  async function openStats() {
    setStatsOpen(true);
    setStatsLoading(true);
    setStatsError('');
    try {
      const { data, error: e } = await client.rpc('portal_inventory_stats');
      if (e) throw e;
      const raw = (data || {}) as Partial<InvStats>;
      setStats({
        total_active_inventory: Number(raw.total_active_inventory) || 0,
        sold_inventory: Number(raw.sold_inventory) || 0,
        ebay: Number(raw.ebay) || 0,
        amazon: Number(raw.amazon) || 0,
        depop: Number(raw.depop) || 0,
        tiktok: Number(raw.tiktok) || 0,
        do_not_list: Number(raw.do_not_list) || 0,
      });
    } catch (err) {
      setStats(null);
      setStatsError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatsLoading(false);
    }
  }

  return (
    <div ref={scrollRef as React.RefObject<HTMLDivElement>}>
      <div className="app-large-title app-large-title-row">
        <h1>Inventory</h1>
        <button type="button" className="app-title-box" onClick={() => { void openStats(); }}>
          Stats
        </button>
      </div>
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
      <div className="app-segment" role="tablist">
        {([
          ['in_stock', 'In stock'],
          ['unfinished', 'Unfinished'],
          ['listed', 'Listed'],
          ['sold', 'Sold'],
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
                  {u.sku} · {u.condition || 'No grade'}
                  {warn ? <> · <span className="warn">{warn}</span></> : null}
                </small>
              </span>
              <span className="app-row-price">
                {u.ask_cents == null ? '—' : money(u.ask_cents)}
              </span>
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

      {statsOpen && (
        <div className="app-stats-sheet" role="dialog" aria-modal="true" aria-label="Inventory stats">
          <button type="button" className="app-stats-backdrop" aria-label="Close stats" onClick={() => setStatsOpen(false)} />
          <div className="app-stats-panel">
            <div className="app-stats-head">
              <h2>Inventory stats</h2>
              <button type="button" className="app-stats-close" onClick={() => setStatsOpen(false)}>Done</button>
            </div>
            {statsLoading && <p className="app-footer-count">Loading…</p>}
            {statsError && <p className="app-inline-error">{statsError}</p>}
            {stats && !statsLoading && (
              <ul className="app-stats-list">
                <li><span>Total active inventory</span><strong>{stats.total_active_inventory}</strong></li>
                <li><span>Sold inventory</span><strong>{stats.sold_inventory}</strong></li>
                <li><span>eBay</span><strong>{stats.ebay}</strong></li>
                <li><span>Amazon</span><strong>{stats.amazon}</strong></li>
                <li><span>Depop</span><strong>{stats.depop}</strong></li>
                <li><span>TikTok</span><strong>{stats.tiktok}</strong></li>
                <li><span>Not able to sell when received</span><strong>{stats.do_not_list}</strong></li>
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
