import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { StaffSession } from '@floor/cloud';
import { floorFunctionUrl } from '../floorApi';
import { MissingFieldPage } from '../MissingFieldPage';
import { MissingCostPage } from '../MissingCostPage';
import { TaxPage } from '../TaxPage';
import { ListingManagerPanel } from '../ListingManagerPanel';
import { MarketplacesPage } from '../MarketplacesPage';
import { errText } from '../errText';
import { shortError } from './shortError';

export type MoreId =
  | 'attention'
  | 'sales'
  | 'ebay'
  | 'amazon'
  | 'tiktok'
  | 'depop'
  | 'connections'
  | 'reports'
  | 'tax'
  | 'settings';

type Kind =
  | 'photo' | 'spec' | 'brand' | 'category' | 'specifics' | 'price' | 'upc' | 'condition' | 'cost' | 'model' | 'description';

const ATTN: { kind: Kind; label: string; blocks: string }[] = [
  { kind: 'photo', label: 'No photos', blocks: 'All marketplaces' },
  { kind: 'spec', label: 'No weight or box size', blocks: 'TikTok, shipping' },
  { kind: 'brand', label: 'No brand', blocks: 'eBay, Amazon' },
  { kind: 'category', label: 'No category details', blocks: 'eBay, Amazon' },
  { kind: 'price', label: 'No price', blocks: 'Website & marketplaces' },
  { kind: 'upc', label: 'No UPC', blocks: 'Amazon / TikTok' },
  { kind: 'condition', label: 'No condition', blocks: 'Listing' },
  { kind: 'cost', label: 'No cost', blocks: 'Profit reports' },
  { kind: 'model', label: 'No model', blocks: 'Matching' },
  { kind: 'description', label: 'No description', blocks: 'Listings' },
];

type Counts = Partial<Record<Kind, number>>;

type Props = {
  client: SupabaseClient;
  session: Session;
  storeId: string;
  fullAccess: boolean;
  staffSession: StaffSession | null;
  money: (n: number) => string;
  stamp: (s: string) => string;
  page: MoreId | null;
  setPage: (p: MoreId | null) => void;
  onOpenChannel: (ch: 'ebay' | 'amazon' | 'tiktok') => void;
  channelContent?: React.ReactNode;
};

function Icon({ tone }: { tone: string }) {
  return <span className="app-more-icon" style={{ background: tone }} />;
}

export function AppMoreHome({
  client, fullAccess, staffSession, session, money, setPage, onOpenChannel,
}: Pick<Props, 'client' | 'fullAccess' | 'staffSession' | 'session' | 'money' | 'setPage' | 'onOpenChannel'>) {
  const [attn, setAttn] = useState<number | null>(null);
  const [salesToday, setSalesToday] = useState<number | null>(null);
  const [ebayN, setEbayN] = useState<string>('…');
  const [amazonN, setAmazonN] = useState<string>('…');
  const [tiktokN, setTiktokN] = useState<string>('Connect');
  const [depopN, setDepopN] = useState<string>('…');
  const [sync, setSync] = useState('…');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const kinds: Kind[] = ['photo', 'spec', 'brand', 'price'];
        let total = 0;
        for (const k of kinds) {
          const { data } = await client.rpc('portal_units_missing_field', { p_kind: k, p_limit: 1, p_offset: 0 });
          total += Number((data as { total?: number })?.total || 0);
        }
        if (alive) setAttn(total);
      } catch { if (alive) setAttn(null); }

      try {
        const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const { data } = await client.rpc('portal_sales', salesRange(day, day));
        if (alive) {
          const rows = Array.isArray(data) ? data as { ticket_key?: string }[] : [];
          setSalesToday(new Set(rows.map((r) => r.ticket_key).filter(Boolean)).size);
        }
      } catch { /* ignore */ }

      // Prefetch channel boards in parallel (Floor-fast catalog) so opening eBay is warm.
      try {
        const token = session.access_token;
        const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
        const post = (body: Record<string, unknown>) =>
          fetch(floorFunctionUrl('listing-manager'), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          }).then((r) => r.json().catch(() => ({})));
        const [ebay, amazon, tiktok, meta] = await Promise.all([
          post({ action: 'board_catalog', channel: 'ebay' }),
          post({ action: 'board_catalog', channel: 'amazon' }),
          post({ action: 'board_catalog', channel: 'tiktok' }),
          post({ action: 'sync_meta' }),
        ]);
        if (!alive) return;
        if (ebay?.listed) setEbayN(String(ebay.listed.length));
        const syncedAt = ebay?.last_synced?.at || meta?.last_synced?.ebay?.at;
        if (syncedAt) {
          const mins = Math.max(0, Math.round((Date.now() - new Date(syncedAt).getTime()) / 60000));
          setSync(mins < 1 ? 'Just now' : `${mins} min ago`);
        }
        if (amazon?.connected === false) setAmazonN('Connect');
        else if (amazon?.listed) setAmazonN(String(amazon.listed.length));
        setTiktokN(tiktok?.connected === false ? 'Connect' : String(tiktok?.listed?.length ?? 0));
      } catch { /* ignore */ }

      void money;
      void depopN;
      setDepopN('Live');
    })();
    return () => { alive = false; };
  }, [client, session.access_token, money]);

  return (
    <>
      <div className="app-large-title"><h1>More</h1></div>

      <div className="app-group">
        <button type="button" className="app-more-link" onClick={() => setPage('attention')}>
          <span className="app-more-left"><Icon tone="#ff9f0a" />Needs attention</span>
          <span className="app-more-right">{attn ?? '…'}<span className="app-chevron">›</span></span>
        </button>
        {fullAccess && (
          <button type="button" className="app-more-link" onClick={() => setPage('sales')}>
            <span className="app-more-left"><Icon tone="#30d158" />Live sales</span>
            <span className="app-more-right">{salesToday ?? '…'}<span className="app-chevron">›</span></span>
          </button>
        )}
      </div>

      {fullAccess && (
        <>
          <p className="app-section-label">Sell online</p>
          <div className="app-group">
            <button type="button" className="app-more-link" onClick={() => onOpenChannel('ebay')}>
              <span className="app-more-left"><Icon tone="#0a84ff" />eBay</span>
              <span className="app-more-right">{ebayN}<span className="app-chevron">›</span></span>
            </button>
            <button type="button" className="app-more-link" onClick={() => onOpenChannel('amazon')}>
              <span className="app-more-left"><Icon tone="#ff9f0a" />Amazon</span>
              <span className="app-more-right">{amazonN}<span className="app-chevron">›</span></span>
            </button>
            <button type="button" className="app-more-link" onClick={() => onOpenChannel('tiktok')}>
              <span className="app-more-left"><Icon tone="#64d2ff" />TikTok</span>
              <span className="app-more-right">{tiktokN}<span className="app-chevron">›</span></span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('depop')}>
              <span className="app-more-left"><Icon tone="#bf5af2" />Depop</span>
              <span className="app-more-right">{depopN}<span className="app-chevron">›</span></span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('connections')}>
              <span className="app-more-left"><Icon tone="#8e8e93" />Connections & sync</span>
              <span className="app-more-right">{sync}<span className="app-chevron">›</span></span>
            </button>
          </div>

          <p className="app-section-label">Money</p>
          <div className="app-group">
            <button type="button" className="app-more-link" onClick={() => setPage('reports')}>
              <span className="app-more-left"><Icon tone="#30d158" />Reports</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('tax')}>
              <span className="app-more-left"><Icon tone="#ffd60a" />Sales tax</span>
              <span className="app-chevron">›</span>
            </button>
          </div>
        </>
      )}

      <div className="app-group">
        <button type="button" className="app-more-link" onClick={() => setPage('settings')}>
          <span className="app-more-left"><Icon tone="#636366" />Settings</span>
          <span className="app-chevron">›</span>
        </button>
      </div>
      <p className="app-footer-count">{staffSession?.displayName || session.user.email}</p>
    </>
  );
}

export function AppAttention({ client, storeId, money, stamp, onBack }: {
  client: SupabaseClient; storeId: string; money: (n: number) => string; stamp: (s: string) => string; onBack: () => void;
}) {
  const [counts, setCounts] = useState<Counts>({});
  const [kind, setKind] = useState<Kind | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const next: Counts = {};
      for (const row of ATTN) {
        if (row.kind === 'cost') {
          try {
            const { data } = await client.rpc('portal_units_missing_cost', { p_limit: 1, p_offset: 0 });
            next.cost = Number((data as { total?: number })?.total || 0);
          } catch { next.cost = 0; }
        } else {
          const { data } = await client.rpc('portal_units_missing_field', { p_kind: row.kind, p_limit: 1, p_offset: 0 });
          next[row.kind] = Number((data as { total?: number })?.total || 0);
        }
      }
      if (alive) setCounts(next);
    })();
    return () => { alive = false; };
  }, [client]);

  if (kind) {
    return (
      <div className="app-stack">
        <div className="app-nav">
          <button type="button" onClick={() => setKind(null)}>‹ Attention</button>
          <div className="app-nav-title">{ATTN.find((a) => a.kind === kind)?.label}</div>
          <button type="button" style={{ visibility: 'hidden' }}>·</button>
        </div>
        <div className="app-embed-soft">
          {kind === 'cost'
            ? <MissingCostPage client={client} money={money} stamp={stamp} onChanged={() => undefined} embedded />
            : <MissingFieldPage client={client} storeId={storeId} kind={kind} money={money} stamp={stamp} />}
        </div>
      </div>
    );
  }

  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
        <div className="app-nav-title">Needs attention</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>
      <div className="app-group">
        {ATTN.map((row) => (
          <button key={row.kind} type="button" className="app-more-link" onClick={() => setKind(row.kind)}>
            <span className="app-more-left">{row.label}</span>
            <span className="app-more-right">
              <span className="warn">{counts[row.kind] ?? '…'}</span>
              <span className="app-chevron">›</span>
            </span>
          </button>
        ))}
      </div>
      <p className="app-footer-count">Tap a row to fix items. Orange fields show what blocks listing.</p>
    </div>
  );
}

/** LA calendar day → exclusive portal_sales window (p_from / p_to). */
function salesRange(startDay: string, endDayInclusive: string) {
  const zone = 'America/Los_Angeles';
  const midnight = (d: string) => {
    const [y, m, a] = d.split('-').map(Number);
    let t = Date.UTC(y, m - 1, a, 8);
    const partsFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    });
    for (let i = 0; i < 3; i++) {
      const p = Object.fromEntries(partsFmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
      const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
      t += Date.UTC(y, m - 1, a) - seen;
    }
    return new Date(t).toISOString();
  };
  const nextDay = (d: string) => {
    const x = new Date(`${d}T12:00:00Z`);
    x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(0, 10);
  };
  return { p_from: midnight(startDay), p_to: midnight(nextDay(endDayInclusive)) };
}

type LiveSaleLine = {
  ticket_key: string;
  sold_at: string;
  channel: string;
  price_cents: number;
  tax_cents?: number | null;
  card_fee_cents?: number | null;
  payment_method?: string | null;
  receipt_no?: string | null;
  profit_cents?: number | null;
  actor_name?: string | null;
  title?: string | null;
  sku?: string | null;
  qty?: number | null;
};

type LiveTicket = {
  key: string;
  at: string;
  channel: string;
  who: string;
  method: string;
  receipt: string;
  sale: number;
  tax: number;
  fee: number;
  /** Customer total = sale + tax (taxes included). */
  total: number;
  profit: number;
  lines: { title: string; sku: string; qty: number; sale: number; tax: number }[];
};

function liveTickets(rows: LiveSaleLine[]): LiveTicket[] {
  const map = new Map<string, LiveTicket>();
  for (const r of rows) {
    const key = r.ticket_key || String(r.sold_at);
    let t = map.get(key);
    if (!t) {
      t = {
        key,
        at: r.sold_at,
        channel: r.channel || 'floor',
        who: r.actor_name || '',
        method: r.payment_method || '',
        receipt: r.receipt_no || '',
        sale: 0,
        tax: 0,
        fee: 0,
        total: 0,
        profit: 0,
        lines: [],
      };
      map.set(key, t);
    }
    const sale = r.price_cents || 0;
    const tax = r.tax_cents || 0;
    t.sale += sale;
    t.tax += tax;
    t.fee += r.card_fee_cents || 0;
    t.profit += r.profit_cents || 0;
    t.lines.push({
      title: r.title || r.sku || 'Item',
      sku: r.sku || '',
      qty: Math.max(1, r.qty || 1),
      sale,
      tax,
    });
  }
  for (const t of map.values()) t.total = t.sale + t.tax;
  return [...map.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

export function AppLiveSales({ client, money, stamp, onBack }: {
  client: SupabaseClient; money: (n: number) => string; stamp: (s: string) => string; onBack: () => void;
}) {
  const [range, setRange] = useState<'today' | 'week' | 'month'>('today');
  const [rows, setRows] = useState<LiveSaleLine[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<LiveTicket | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setError('');
      setOpen(null);
      try {
        const end = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const d = new Date();
        if (range === 'week') d.setDate(d.getDate() - 6);
        if (range === 'month') d.setDate(1);
        const start = range === 'today' ? end : d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const { data, error: e } = await client.rpc('portal_sales', salesRange(start, end));
        if (e) throw e;
        if (!alive) return;
        setRows((data || []) as LiveSaleLine[]);
      } catch (e) {
        if (alive) {
          setRows([]);
          setError(shortError(errText(e)));
        }
      }
    })();
    return () => { alive = false; };
  }, [client, range]);

  const tickets = useMemo(() => liveTickets(rows), [rows]);
  const summary = useMemo(() => ({
    sales: tickets.reduce((n, t) => n + t.total, 0),
    orders: tickets.length,
    profit: tickets.reduce((n, t) => n + t.profit, 0),
  }), [tickets]);

  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
        <div className="app-nav-title">Live sales</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>
      <div className="app-segment">
        {([['today', 'Today'], ['week', 'This week'], ['month', 'This month']] as const).map(([id, label]) => (
          <button key={id} type="button" className={range === id ? 'active' : ''} onClick={() => setRange(id)}>{label}</button>
        ))}
      </div>
      <div className="app-stat-grid cols-3">
        <div><span>Sales</span><strong>{money(summary.sales)}</strong></div>
        <div><span>Orders</span><strong>{summary.orders}</strong></div>
        <div><span>Profit</span><strong className="pos">{money(summary.profit)}</strong></div>
      </div>
      {error && <p className="app-inline-error">{error}</p>}
      <div className="app-group">
        {tickets.length === 0 && <div className="app-empty-row">No sales in this range</div>}
        {tickets.map((t) => (
          <button type="button" className="app-row" key={t.key} onClick={() => setOpen(t)}>
            <span className="app-row-text">
              <strong>{money(t.total)} · {t.channel || 'floor'}</strong>
              <small>{stamp(t.at)}{t.who ? ` · ${t.who}` : ''}</small>
              <small className="live">Pulled everywhere</small>
            </span>
            <span className="app-chevron" aria-hidden>›</span>
          </button>
        ))}
      </div>

      {open && (
        <div className="app-stats-sheet" role="dialog" aria-modal="true" aria-label="Sale breakdown">
          <button type="button" className="app-stats-backdrop" aria-label="Close" onClick={() => setOpen(null)} />
          <div className="app-stats-panel">
            <div className="app-stats-head">
              <h2>Sale</h2>
              <button type="button" className="app-stats-close" onClick={() => setOpen(null)}>Done</button>
            </div>
            <p className="app-footer-count" style={{ marginTop: 0 }}>
              {stamp(open.at)}
              {open.who ? ` · ${open.who}` : ''}
              {open.channel ? ` · ${open.channel}` : ''}
              {open.method ? ` · ${open.method}` : ''}
              {open.receipt ? ` · #${open.receipt}` : ''}
            </p>
            <ul className="app-stats-list">
              <li><span>Sale price</span><strong>{money(open.sale)}</strong></li>
              <li><span>Tax</span><strong>{money(open.tax)}</strong></li>
              {open.fee > 0 && <li><span>Card fees</span><strong>{money(open.fee)}</strong></li>}
              <li><span>Total</span><strong>{money(open.total)}</strong></li>
              <li><span>Profit</span><strong>{money(open.profit)}</strong></li>
            </ul>
            {open.lines.length > 0 && (
              <>
                <p className="app-footer-count">Items</p>
                <ul className="app-stats-list">
                  {open.lines.map((line, i) => (
                    <li key={`${line.sku}-${i}`}>
                      <span>
                        {line.title}
                        {line.qty > 1 ? ` ×${line.qty}` : ''}
                        {line.sku ? <small style={{ display: 'block', color: '#8e8e93' }}>SKU {line.sku}</small> : null}
                      </span>
                      <strong>{money(line.sale + line.tax)}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function AppConnections({ client, accessToken, money, stamp, onBack }: {
  client: SupabaseClient; accessToken: string; money: (n: number) => string; stamp: (s: string) => string; onBack: () => void;
}) {
  void client; void money;
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
        <div className="app-nav-title">Connections & sync</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>
      <div className="app-embed-soft">
        <MarketplacesPage client={client} accessToken={accessToken} money={money} stamp={stamp} />
      </div>
    </div>
  );
}

export function AppReportsNative({ onBack, children }: {
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
        <div className="app-nav-title">Reports</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>
      <div className="app-embed-soft app-reports">
        {children}
      </div>
    </div>
  );
}

export function AppTaxNative({ client, money, stamp, onBack }: {
  client: SupabaseClient; money: (n: number) => string; stamp: (s: string) => string; onBack: () => void;
}) {
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
        <div className="app-nav-title">Sales tax</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>
      <div className="app-embed-soft">
        <TaxPage client={client} money={money} stamp={stamp} />
      </div>
    </div>
  );
}

export function AppDepopNative({ accessToken, money, onBack }: {
  accessToken: string; money: (n: number) => string; onBack: () => void;
}) {
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
        <div className="app-nav-title">Depop</div>
        <button type="button" style={{ visibility: 'hidden' }}>+</button>
      </div>
      <div className="app-embed-soft">
        <ListingManagerPanel accessToken={accessToken} money={money} channel="depop" channelLocked />
      </div>
    </div>
  );
}

export function AppSettingsNative({
  client, fullAccess, staffSession, session, settingsSlot, onBack,
}: {
  client: SupabaseClient;
  fullAccess: boolean;
  staffSession: StaffSession | null;
  session: Session;
  settingsSlot: React.ReactNode;
  /** Omit when Settings is a root tab (associates). */
  onBack?: () => void;
}) {
  void fullAccess;
  return (
    <div className="app-stack">
      <div className="app-nav">
        {onBack
          ? <button type="button" onClick={onBack}>‹ More</button>
          : <button type="button" style={{ visibility: 'hidden' }}>·</button>}
        <div className="app-nav-title">Settings</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>
      <div className="app-embed-soft">{settingsSlot}</div>
      <button
        type="button"
        className="app-primary"
        style={{ background: '#1c1c1e', color: '#ff453a' }}
        onClick={() => void client.auth.signOut({ scope: 'local' })}
      >
        Sign out
      </button>
      <p className="app-footer-count">{staffSession?.displayName || session.user.email}</p>
    </div>
  );
}
