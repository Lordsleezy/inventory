import { useEffect, useMemo, useState } from 'react';
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

type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
  onOpen: (sku: string) => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
};

function thumb(path: string) {
  const parts = path.split('/');
  if (parts.length < 3 || parts[1] === 'archive' || parts[2] === 'web') return path;
  const stem = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  return `${parts[0]}/${parts[1]}/web/400/${stem}.webp`;
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
  const [list, setList] = useState<List | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unfinishedCount, setUnfinishedCount] = useState<number | null>(null);

  async function sign(paths: string[]) {
    const keys = [...new Set(paths.filter((p) => /^[0-9a-f-]{36}\//i.test(p)))];
    if (!keys.length) return {} as Record<string, string>;
    const { data, error: e } = await client.storage.from('unit-photos').createSignedUrls(keys, 3600);
    if (e) throw e;
    return Object.fromEntries((data || []).map((x, i) => [keys[i], x.signedUrl || '']));
  }

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      setLoading(true);
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
            p_limit: 40,
          });
          if (e) throw e;
          const next = data as List;
          const signed = await sign(
            next.items.flatMap((x) => (x.photo_path ? [thumb(x.photo_path), x.photo_path] : [])),
          ).catch(() => ({}));
          if (!alive) return;
          setList(next);
          setUrls((prev) => ({ ...prev, ...signed }));
        } catch (err) {
          if (alive) {
            setError(err instanceof Error ? err.message : String(err));
            setList({ items: [], totals: { unit_count: 0 } });
          }
        } finally {
          if (alive) setLoading(false);
        }
      })();
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, filter, query, offset]);

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
  }, [client, list]);

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
    setList(null);
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

      <div className="app-group">
        {(list?.items || []).map((u) => {
          const warn = needs(u);
          const src = u.photo_path ? urls[thumb(u.photo_path)] || urls[u.photo_path] : '';
          return (
            <button type="button" className="app-row" key={u.sku} onClick={() => onOpen(u.sku)}>
              <span className="app-thumb">
                {src ? <img src={src} alt="" loading="lazy" /> : '+'}
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
            {error ? 'Couldn’t load inventory — pull to retry or reopen the tab.' : 'Nothing matches this filter.'}
          </div>
        )}
      </div>

      <div className="app-footer-count">{footer}</div>
      {total > 40 && (
        <div className="app-actions" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 40))}>Previous</button>
          <button type="button" disabled={offset + 40 >= total || loading} onClick={() => setOffset(offset + 40)}>Next</button>
        </div>
      )}
    </div>
  );
}
