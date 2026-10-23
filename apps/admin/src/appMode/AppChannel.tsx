import { useCallback, useEffect, useMemo, useState } from 'react';
import { floorFunctionUrl } from '../floorApi';
import { errText } from '../errText';
import { shortError } from './shortError';

export type AppChannelId = 'ebay' | 'amazon' | 'tiktok';
type Tab = 'listed' | 'not_listed' | 'sold';

type CatalogRow = {
  key: string;
  sku: string | null;
  title: string;
  price_cents: number | null;
  condition: string | null;
  shipping: string;
  photo_url: string | null;
  live: boolean;
  blocked_reason: string | null;
};

type SoldRow = {
  key: string;
  sku: string | null;
  title: string;
  condition: string | null;
  price_cents: number;
  photo_url: string | null;
  sold_at: string;
};

type Stats = {
  orders: number;
  gross_cents: number;
  fee_cents: number;
  ship_cents: number;
  profit_cents: number;
};

type Quarter = { id: string; label: string };

const ZONE = 'America/Los_Angeles';
const TITLES: Record<AppChannelId, string> = { ebay: 'eBay', amazon: 'Amazon', tiktok: 'TikTok' };

function boardCacheKey(channel: AppChannelId) {
  return `floor_board_cache_${channel}`;
}

function readBoardCache(channel: AppChannelId): {
  listed?: CatalogRow[];
  not_listed?: CatalogRow[];
  connected?: boolean;
  connect_message?: string;
} | null {
  try {
    const raw = sessionStorage.getItem(boardCacheKey(channel));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeBoardCache(channel: AppChannelId, pack: {
  listed: CatalogRow[];
  not_listed: CatalogRow[];
  connected: boolean;
  connect_message: string;
}) {
  try {
    sessionStorage.setItem(boardCacheKey(channel), JSON.stringify(pack));
  } catch {
    /* quota / private mode */
  }
}

function clientQuarter(now = new Date()): Quarter {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: 'numeric' }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const q = Math.floor((month - 1) / 3) + 1;
  const span = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'][q - 1];
  return { id: `${year}-Q${q}`, label: `Q${q} ${year} (${span})` };
}

async function call(token: string, body: Record<string, unknown>) {
  const res = await fetch(floorFunctionUrl('listing-manager'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status >= 400 || json.ok === false) throw new Error(json.error || json.message || `Request failed (${res.status})`);
  return json;
}

function shipLabel(s: string) {
  if (s === 'free') return 'Free ship';
  if (s === 'buyer') return 'Buyer pays';
  return '';
}

type Props = {
  channel: AppChannelId;
  accessToken: string;
  money: (n: number) => string;
  onBack: () => void;
};

export function AppChannel({ channel, accessToken, money, onBack }: Props) {
  const cached = useMemo(() => readBoardCache(channel), [channel]);
  const [tab, setTab] = useState<Tab>('listed');
  const [query, setQuery] = useState('');
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quarter, setQuarter] = useState(() => clientQuarter().id);
  const [quarters, setQuarters] = useState<Quarter[]>(() => [clientQuarter()]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [listed, setListed] = useState<CatalogRow[]>(() => cached?.listed || []);
  const [notListed, setNotListed] = useState<CatalogRow[]>(() => cached?.not_listed || []);
  const [sold, setSold] = useState<SoldRow[]>([]);
  const [connected, setConnected] = useState(() => cached?.connected ?? channel !== 'tiktok');
  const [connectMessage, setConnectMessage] = useState(() => cached?.connect_message || '');
  const [error, setError] = useState('');
  const [catalogBusy, setCatalogBusy] = useState(() => !cached);
  const [quarterBusy, setQuarterBusy] = useState(true);
  const [pulling, setPulling] = useState(false);

  const loadCatalog = useCallback(async (opts?: { force?: boolean }) => {
    setCatalogBusy(true);
    setError('');
    try {
      const cat = await call(accessToken, {
        action: 'board_catalog',
        channel,
        ...(opts?.force ? { force: true } : {}),
      });
      const nextListed = cat.listed || [];
      const nextNotListed = cat.not_listed || [];
      const nextConnected = cat.connected !== false;
      const nextMessage = cat.connect_message || '';
      setListed(nextListed);
      setNotListed(nextNotListed);
      setConnected(nextConnected);
      setConnectMessage(nextMessage);
      writeBoardCache(channel, {
        listed: nextListed,
        not_listed: nextNotListed,
        connected: nextConnected,
        connect_message: nextMessage,
      });
      const notes: string[] = [];
      for (const a of cat.accounts || []) {
        if (a?.error) notes.push(shortError(a.error));
      }
      if (notes.length) setError(notes[0]);
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setCatalogBusy(false);
      setPulling(false);
    }
  }, [accessToken, channel]);

  const loadQuarter = useCallback(async (id: string) => {
    setQuarterBusy(true);
    try {
      const q = await call(accessToken, { action: 'board_quarter', channel, quarter: id });
      setStats(q.stats || null);
      setSold(q.sold || []);
      if (q.quarters?.length) setQuarters(q.quarters);
    } catch (e) {
      setError(shortError(errText(e)));
    } finally {
      setQuarterBusy(false);
    }
  }, [accessToken, channel]);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  useEffect(() => { void loadQuarter(quarter); }, [loadQuarter, quarter]);

  const source = tab === 'listed' ? listed : tab === 'not_listed' ? notListed : sold;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((row) => {
      if (!q) return true;
      return [row.sku, row.title, 'condition' in row ? row.condition : ''].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [source, query]);

  async function runJob(kind: string) {
    const keys = [...selected];
    if (!keys.length) return;
    setError('');
    try {
      await call(accessToken, { action: 'board_job', channel, kind, keys });
      setSelected(new Set());
      setSelecting(false);
      void loadCatalog({ force: true });
      void loadQuarter(quarter);
    } catch (e) {
      setError(shortError(errText(e)));
    }
  }

  const listBusy = tab === 'sold' ? quarterBusy : catalogBusy;
  const title = TITLES[channel];

  return (
    <div className="app-stack app-channel">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
        <div className="app-nav-title">{title}</div>
        <button
          type="button"
          onClick={() => {
            if (selecting) { setSelecting(false); setSelected(new Set()); }
            else setSelecting(true);
          }}
        >
          {selecting ? 'Done' : 'Select'}
        </button>
      </div>

      <div className="app-channel-tools">
        <button
          type="button"
          className="app-quarter"
          onClick={() => {
            const i = quarters.findIndex((q) => q.id === quarter);
            const next = quarters[(i + 1) % Math.max(quarters.length, 1)] || clientQuarter();
            setQuarter(next.id);
          }}
        >
          {quarters.find((q) => q.id === quarter)?.label || quarter}
        </button>
        <button
          type="button"
          className="app-nav-plus"
          aria-label="Add listing"
          onClick={() => { window.location.href = `/?page=${channel}`; }}
        >
          +
        </button>
      </div>

      <div className="app-stat-grid">
        <div><span>Sales</span><strong>{quarterBusy && !stats ? '…' : money(stats?.gross_cents || 0)}</strong></div>
        <div><span>Fees</span><strong>{quarterBusy && !stats ? '…' : money(stats?.fee_cents || 0)}</strong></div>
        <div><span>Shipping labels</span><strong>{quarterBusy && !stats ? '…' : money(stats?.ship_cents || 0)}</strong></div>
        <div><span>Profit</span><strong className="pos">{quarterBusy && !stats ? '…' : money(stats?.profit_cents || 0)}</strong></div>
      </div>

      <div className="app-segment">
        {([
          ['listed', 'Listed', listed.length],
          ['not_listed', 'Not listed', notListed.length],
          ['sold', 'Sold', sold.length],
        ] as const).map(([id, label, n]) => (
          <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => { setTab(id); setSelected(new Set()); }}>
            {label}{typeof n === 'number' ? ` ${n}` : ''}
          </button>
        ))}
      </div>

      <div className="app-search">
        <span aria-hidden>⌕</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" />
      </div>

      {error && <p className="app-inline-error">{error}</p>}

      {!connected && channel === 'tiktok' && (
        <button type="button" className="app-group app-connect-row" onClick={() => { /* navigate via more */ window.history.back(); }}>
          <span>Connect TikTok</span>
          <span className="app-chevron">›</span>
        </button>
      )}

      <div
        className="app-group"
        onTouchStart={(e) => { (e.currentTarget as HTMLElement).dataset.y = String(e.touches[0]?.clientY || 0); }}
        onTouchEnd={(e) => {
          const start = Number((e.currentTarget as HTMLElement).dataset.y || 0);
          const end = e.changedTouches[0]?.clientY || 0;
          if (end - start > 80 && !pulling) {
            setPulling(true);
            void loadCatalog({ force: true });
            void loadQuarter(quarter);
          }
        }}
      >
        {filtered.length === 0 && !listBusy && (
          <div className="app-empty-row">{pulling || listBusy ? 'Loading…' : 'Nothing here'}</div>
        )}
        {filtered.length === 0 && listBusy && (
          <div className="app-empty-row">Loading…</div>
        )}
        {filtered.map((row) => {
          const key = row.key;
          const price = 'price_cents' in row ? row.price_cents : null;
          const cond = 'condition' in row ? row.condition : null;
          const ship = 'shipping' in row ? shipLabel(String(row.shipping || '')) : '';
          const meta = [row.sku, cond, ship].filter(Boolean).join(' · ');
          const checked = selected.has(key);
          return (
            <button
              key={key}
              type="button"
              className="app-row"
              onClick={() => {
                if (!selecting) return;
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key); else next.add(key);
                  return next;
                });
              }}
            >
              {selecting && (
                <span className={`app-check ${checked ? 'on' : ''}`} aria-hidden>{checked ? '✓' : ''}</span>
              )}
              <span className="app-thumb">
                {row.photo_url ? <img src={row.photo_url} alt="" loading="lazy" decoding="async" /> : '+'}
              </span>
              <span className="app-row-text">
                <strong>{row.title || 'Untitled'}</strong>
                <small>{meta || '—'}</small>
                {'blocked_reason' in row && row.blocked_reason ? <small className="warn">{row.blocked_reason}</small> : null}
              </span>
              <span className="app-row-price">{price != null ? money(price) : ''}</span>
              {!selecting && <span className="app-chevron">›</span>}
            </button>
          );
        })}
      </div>

      {connectMessage && !connected && <p className="app-footer-count">{connectMessage}</p>}

      {selecting && selected.size > 0 && (
        <div className="app-bulk-bar">
          <button type="button" onClick={() => void runJob(tab === 'listed' ? 'delist' : 'list')}>
            {tab === 'listed' ? 'Delist' : 'List'}
          </button>
          <button type="button" onClick={() => void runJob('mark_sold')}>Mark sold</button>
          <span>{selected.size} selected</span>
        </div>
      )}
    </div>
  );
}
