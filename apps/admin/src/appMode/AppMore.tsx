import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { StaffSession } from '@floor/cloud';
import { floorFunctionUrl } from '../floorApi';
import { ListingManagerPanel } from '../ListingManagerPanel';
import { DepopSalePanel } from '../DepopSalePanel';
import { DepopLiveListingsPanel } from '../DepopLiveListingsPanel';
import { MercariSalePanel } from '../MercariSalePanel';
import { MercariLiveListingsPanel } from '../MercariLiveListingsPanel';
import { ConnectionsPage } from '../ConnectionsPage';
import { isInStoreChannel } from '../channels';
import { errText } from '../errText';
import { shortError } from './shortError';
import { BuildStamp } from '../BuildStamp';

/** Needs attention moved to Inventory → Unfinished; it is not a More page. */
export type MoreId =
  | 'register'
  | 'sales'
  | 'receipts'
  | 'other'
  | 'ebay'
  | 'amazon'
  | 'tiktok'
  | 'depop'
  | 'mercari'
  | 'connections'
  | 'reports'
  | 'withdrawals'
  | 'books'
  | 'manifests'
  | 'locations'
  | 'insights'
  | 'settings';

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

function Icon(_props: { tone: string }) {
  return null;
}

function laMidnight(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  let time = Date.UTC(year, month - 1, day, 8);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(time)).map(part => [part.type, Number(part.value)]));
    time += Date.UTC(year, month - 1, day) - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  }
  return new Date(time).toISOString();
}
function addDays(date: string, amount: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

export function AppMoreHome({
  client, fullAccess, staffSession, session, money, setPage, onOpenChannel,
}: Pick<Props, 'client' | 'fullAccess' | 'staffSession' | 'session' | 'money' | 'setPage' | 'onOpenChannel'>) {
  void onOpenChannel;
  void money;
  const [salesToday, setSalesToday] = useState<number | null>(null);

  useEffect(() => {
    if (!fullAccess) return;
    let alive = true;
    void (async () => {
      try {
        const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const { data, error } = await client.rpc('portal_sales', { p_from: laMidnight(day), p_to: laMidnight(addDays(day, 1)) });
        if (error) throw error;
        if (alive) {
          setSalesToday(
            Array.isArray(data)
              ? new Set((data as { ticket_key?: string }[]).map((r) => r.ticket_key).filter(Boolean)).size
              : 0,
          );
        }
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [client, fullAccess]);

  return (
    <>
      <div className="app-large-title"><h1>More</h1></div>

      {fullAccess ? (
        <>
          <div className="app-group">
            <button type="button" className="app-more-link" onClick={() => setPage('sales')}>
              <span className="app-more-left"><Icon tone="#30d158" />Live sales</span>
              <span className="app-more-right">{salesToday ?? '…'}<span className="app-chevron">›</span></span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('receipts')}>
              <span className="app-more-left"><Icon tone="#ffd60a" />Receipts</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('register')}>
              <span className="app-more-left"><Icon tone="#0a84ff" />Register</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('withdrawals')}>
              <span className="app-more-left"><Icon tone="#8e8e93" />Safe</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('reports')}>
              <span className="app-more-left"><Icon tone="#30d158" />Reports</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('books')}>
              <span className="app-more-left"><Icon tone="#ff9f0a" />Books</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('locations')}>
              <span className="app-more-left"><Icon tone="#30d158" />Locations</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('other')}>
              <span className="app-more-left"><Icon tone="#8e8e93" />Other</span>
              <span className="app-chevron">›</span>
            </button>
          </div>
        </>
      ) : staffSession ? (
        <div className="app-group">
          <button type="button" className="app-more-link" onClick={() => setPage('register')}>
            <span className="app-more-left"><Icon tone="#0a84ff" />Register</span>
            <span className="app-chevron">›</span>
          </button>
        </div>
      ) : null}

      <p className="app-footer-count">{staffSession?.displayName || session.user.email}</p>
      <BuildStamp />
    </>
  );
}

/** Everything that used to sit on More home, now one tap behind Other. */
export function AppMoreOther({
  client, session, setPage, onOpenChannel, onBack,
}: {
  client: SupabaseClient;
  session: Session;
  setPage: (p: MoreId) => void;
  onOpenChannel: (ch: 'ebay' | 'amazon' | 'tiktok') => void;
  onBack: () => void;
}) {
  const [ebayN, setEbayN] = useState('…');
  const [amazonN, setAmazonN] = useState('…');
  const [tiktokN, setTiktokN] = useState('Connect');
  const [depopN, setDepopN] = useState('…');
  const [sync, setSync] = useState('…');

  useEffect(() => {
    let alive = true;
    void (async () => {
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
      try {
        const depopLive = await client.rpc('portal_depop_live_listings');
        if (!alive) return;
        if (!depopLive.error) setDepopN(String(((depopLive.data || []) as unknown[]).length));
        else setDepopN('Live');
      } catch {
        if (alive) setDepopN('Live');
      }
    })();
    return () => { alive = false; };
  }, [client, session.access_token]);

  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
        <div className="app-nav-title">Other</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>

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

      <p className="app-section-label">Other tools</p>
      <div className="app-group">
        <button type="button" className="app-more-link" onClick={() => setPage('insights')}>
          <span className="app-more-left"><Icon tone="#5e5ce6" />Insights</span>
          <span className="app-chevron">›</span>
        </button>
      </div>

      <p className="app-section-label">Inventory records</p>
      <div className="app-group">
        <button type="button" className="app-more-link" onClick={() => setPage('manifests')}>
          <span className="app-more-left"><Icon tone="#ff9f0a" />Manifests</span>
          <span className="app-chevron">›</span>
        </button>
      </div>

      <div className="app-group">
        <button type="button" className="app-more-link" onClick={() => setPage('settings')}>
          <span className="app-more-left"><Icon tone="#636366" />Settings</span>
          <span className="app-chevron">›</span>
        </button>
      </div>
    </div>
  );
}

/** Rows from `portal_sales` (see supabase migrations) — not the mistaken ticket_id/total_cents shape. */
type PortalSalesLine = {
  id?: number;
  ticket_key: string;
  sold_at: string;
  channel: string | null;
  title: string | null;
  price_cents: number | null;
  tax_cents: number | null;
  card_fee_cents: number | null;
  profit_cents: number | null;
  actor_name: string | null;
};

function liveChannelLabel(channel: string | null | undefined) {
  return isInStoreChannel(channel) ? 'In store' : (channel || 'online');
}

export function AppLiveSales({ client, money, stamp, onBack }: {
  client: SupabaseClient; money: (n: number) => string; stamp: (s: string) => string; onBack: () => void;
}) {
  const [range, setRange] = useState<'today' | 'week' | 'month'>('today');
  const [rows, setRows] = useState<PortalSalesLine[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const end = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const d = new Date();
        if (range === 'week') d.setDate(d.getDate() - 6);
        if (range === 'month') d.setDate(1);
        const start = range === 'today' ? end : d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const { data, error: e } = await client.rpc('portal_sales', {
          p_from: laMidnight(start),
          p_to: laMidnight(addDays(end, 1)),
        });
        if (e) throw e;
        if (!alive) return;
        setRows((data || []) as PortalSalesLine[]);
      } catch (e) {
        if (alive) setError(shortError(errText(e)));
      }
    })();
    return () => { alive = false; };
  }, [client, range]);

  const summary = useMemo(() => {
    const tickets = new Map<string, { total: number; profit: number; channel: string; at: string; who: string; title: string }>();
    for (const r of rows) {
      const id = r.ticket_key || String(r.id ?? r.sold_at);
      const lineTotal = (r.price_cents ?? 0) + (r.tax_cents ?? 0) + (r.card_fee_cents ?? 0);
      const existing = tickets.get(id);
      if (!existing) {
        tickets.set(id, {
          total: lineTotal,
          profit: r.profit_cents ?? 0,
          channel: r.channel || 'floor',
          at: r.sold_at,
          who: r.actor_name || '',
          title: r.title || '',
        });
      } else {
        existing.total += lineTotal;
        existing.profit += r.profit_cents ?? 0;
      }
    }
    const list = [...tickets.values()];
    return {
      list: list.sort((a, b) => (a.at < b.at ? 1 : -1)),
      sales: list.reduce((n, t) => n + t.total, 0),
      orders: list.length,
      profit: list.reduce((n, t) => n + t.profit, 0),
    };
  }, [rows]);

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
        {summary.list.length === 0 && <div className="app-empty-row">No sales in this range</div>}
        {summary.list.map((t, i) => (
          <div key={i} className="app-row" style={{ cursor: 'default' }}>
            <span className="app-row-text">
              <strong>{money(t.total)} · {liveChannelLabel(t.channel)}</strong>
              <small>{stamp(t.at)}{t.who ? ` · ${t.who}` : ''}</small>
              <small className="live">Pulled everywhere</small>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AppConnections({ accessToken, onBack, backLabel = 'More' }: {
  client: SupabaseClient; accessToken: string; money: (n: number) => string; stamp: (s: string) => string; onBack: () => void; backLabel?: string;
}) {
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ {backLabel}</button>
        <div className="app-nav-title">Connections & sync</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>
      <ConnectionsPage accessToken={accessToken} standalone />
    </div>
  );
}

export function AppReportsNative({ onBack, children, title = 'Reports', backLabel = 'More', action, onAction }: {
  onBack: () => void;
  children: ReactNode;
  title?: string;
  backLabel?: string;
  action?: 'add' | 'download' | 'owner';
  onAction?: () => void;
}) {
  const actionLabel = action === 'add' ? '+' : action === 'download' ? '↓' : action === 'owner' ? 'Owner payout' : null;
  const actionAria = action === 'add' ? 'Add expense' : action === 'download' ? 'Download report' : action === 'owner' ? 'Owner payout' : undefined;
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ {backLabel}</button>
        <div className="app-nav-title">{title}</div>
        {actionLabel
          ? <button type="button" className={action === 'owner' ? 'app-nav-text-action' : undefined} aria-label={actionAria} onClick={onAction}>{actionLabel}</button>
          : <button type="button" style={{ visibility: 'hidden' }}>·</button>}
      </div>
      <div className="app-embed-soft app-reports">
        {children}
      </div>
    </div>
  );
}

export function AppDepopNative({ client, accessToken, money, onBack, backLabel = 'More' }: {
  client: SupabaseClient; accessToken: string; money: (n: number) => string; onBack: () => void; backLabel?: string;
}) {
  const [tab, setTab] = useState<'listed'|'sales'|'manage'>('listed');
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ {backLabel}</button>
        <div className="app-nav-title">Depop</div>
        <button type="button" style={{ visibility: 'hidden' }}>+</button>
      </div>
      <div className="app-embed-soft">
        <nav className="depop-tabs" aria-label="Depop sections">
          <button type="button" aria-current={tab==='listed'?'page':undefined} onClick={()=>setTab('listed')}>Listed</button>
          <button type="button" aria-current={tab==='sales'?'page':undefined} onClick={()=>setTab('sales')}>Sales</button>
          <button type="button" aria-current={tab==='manage'?'page':undefined} onClick={()=>setTab('manage')}>Manage</button>
        </nav>
        {tab==='listed'&&<DepopLiveListingsPanel client={client} money={money} variant="app" />}
        {tab==='sales'&&<DepopSalePanel client={client} money={money} variant="app" />}
        {tab==='manage'&&<ListingManagerPanel accessToken={accessToken} money={money} channel="depop" channelLocked />}
      </div>
    </div>
  );
}

export function AppMercariNative({ client, accessToken, money, onBack, backLabel = 'More' }: {
  client: SupabaseClient; accessToken: string; money: (n: number) => string; onBack: () => void; backLabel?: string;
}) {
  const [tab, setTab] = useState<'listed'|'sales'|'manage'>('listed');
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ {backLabel}</button>
        <div className="app-nav-title">Mercari</div>
        <button type="button" style={{ visibility: 'hidden' }}>+</button>
      </div>
      <div className="app-embed-soft">
        <nav className="depop-tabs" aria-label="Mercari sections">
          <button type="button" aria-current={tab==='listed'?'page':undefined} onClick={()=>setTab('listed')}>Listed</button>
          <button type="button" aria-current={tab==='sales'?'page':undefined} onClick={()=>setTab('sales')}>Sales</button>
          <button type="button" aria-current={tab==='manage'?'page':undefined} onClick={()=>setTab('manage')}>Manage</button>
        </nav>
        {tab==='listed'&&<MercariLiveListingsPanel client={client} money={money} variant="app" />}
        {tab==='sales'&&<MercariSalePanel client={client} money={money} variant="app" />}
        {tab==='manage'&&<ListingManagerPanel accessToken={accessToken} money={money} channel="mercari" channelLocked />}
      </div>
    </div>
  );
}

export function AppSettingsNative({
  client, fullAccess, staffSession, session, settingsSlot, onBack, backLabel = 'More',
}: {
  client: SupabaseClient;
  fullAccess: boolean;
  staffSession: StaffSession | null;
  session: Session;
  settingsSlot: React.ReactNode;
  /** Omit when Settings is a root tab (associates). */
  onBack?: () => void;
  backLabel?: string;
}) {
  void fullAccess;
  return (
    <div className="app-stack">
      <div className="app-nav">
        {onBack
          ? <button type="button" onClick={onBack}>‹ {backLabel}</button>
          : <button type="button" style={{ visibility: 'hidden' }}>·</button>}
        <div className="app-nav-title">Settings</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>
      <div className="app-embed-soft">{settingsSlot}</div>
      <button type="button" className="app-primary" onClick={() => {
        if (window.confirm('Restart Floor? Unsaved form edits will be lost. Preserved interrupted saves remain recoverable.')) window.location.reload();
      }}>Restart app</button>
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
