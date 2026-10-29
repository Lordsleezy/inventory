import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { StaffSession } from '@floor/cloud';
import { floorFunctionUrl } from '../floorApi';
import { ListingManagerPanel } from '../ListingManagerPanel';
import { DepopSalePanel } from '../DepopSalePanel';
import { DepopLiveListingsPanel } from '../DepopLiveListingsPanel';
import { ConnectionsPage } from '../ConnectionsPage';
import { errText } from '../errText';
import { shortError } from './shortError';

/** Needs attention moved to Inventory → Unfinished; it is not a More page. */
export type MoreId =
  | 'sales'
  | 'ebay'
  | 'amazon'
  | 'tiktok'
  | 'depop'
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

function Icon({ tone }: { tone: string }) {
  return <span className="app-more-icon" style={{ background: tone }} />;
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
        const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
        const { data, error } = await client.rpc('portal_sales', { p_from: laMidnight(day), p_to: laMidnight(addDays(day, 1)) });
        if (error) throw error;
        if (alive) setSalesToday(Array.isArray(data) ? new Set((data as { ticket_id?: string }[]).map((r) => r.ticket_id)).size : 0);
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
            <button type="button" className="app-more-link" onClick={() => setPage('insights')}>
              <span className="app-more-left"><Icon tone="#5e5ce6" />Insights</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('withdrawals')}>
              <span className="app-more-left"><Icon tone="#64d2ff" />Money</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('books')}>
              <span className="app-more-left"><Icon tone="#ff9f0a" />Books</span>
              <span className="app-chevron">›</span>
            </button>
          </div>
          <p className="app-section-label">Inventory records</p>
          <div className="app-group">
            <button type="button" className="app-more-link" onClick={() => setPage('manifests')}>
              <span className="app-more-left"><Icon tone="#ff9f0a" />Manifests</span>
              <span className="app-chevron">›</span>
            </button>
            <button type="button" className="app-more-link" onClick={() => setPage('locations')}>
              <span className="app-more-left"><Icon tone="#30d158" />Locations</span>
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

export function AppLiveSales({ client, money, stamp, onBack }: {
  client: SupabaseClient; money: (n: number) => string; stamp: (s: string) => string; onBack: () => void;
}) {
  const [range, setRange] = useState<'today' | 'week' | 'month'>('today');
  const [rows, setRows] = useState<{ ticket_id: string; sold_at: string; channel: string; total_cents: number; profit_cents?: number; sold_by?: string; title?: string }[]>([]);
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
        setRows((data || []) as typeof rows);
      } catch (e) {
        if (alive) setError(shortError(errText(e)));
      }
    })();
    return () => { alive = false; };
  }, [client, range]);

  const summary = useMemo(() => {
    const tickets = new Map<string, { total: number; profit: number; channel: string; at: string; who: string; title: string }>();
    for (const r of rows) {
      const id = r.ticket_id || String(r.sold_at);
      const cur = tickets.get(id) || { total: 0, profit: 0, channel: r.channel, at: r.sold_at, who: r.sold_by || '', title: r.title || '' };
      cur.total += r.total_cents || 0;
      cur.profit += r.profit_cents || 0;
      tickets.set(id, cur);
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
              <strong>{money(t.total)} · {t.channel || 'floor'}</strong>
              <small>{stamp(t.at)}{t.who ? ` · ${t.who}` : ''}</small>
              <small className="live">Pulled everywhere</small>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AppConnections({ accessToken, onBack }: {
  client: SupabaseClient; accessToken: string; money: (n: number) => string; stamp: (s: string) => string; onBack: () => void;
}) {
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
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
  action?: 'add' | 'download';
  onAction?: () => void;
}) {
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ {backLabel}</button>
        <div className="app-nav-title">{title}</div>
        {action ? <button type="button" aria-label={action === 'add' ? 'Add expense' : 'Download report'} onClick={onAction}>{action === 'add' ? '+' : '↓'}</button> : <button type="button" style={{ visibility: 'hidden' }}>·</button>}
      </div>
      <div className="app-embed-soft app-reports">
        {children}
      </div>
    </div>
  );
}

export function AppDepopNative({ client, accessToken, money, onBack }: {
  client: SupabaseClient; accessToken: string; money: (n: number) => string; onBack: () => void;
}) {
  const [tab, setTab] = useState<'listed'|'sales'|'manage'>('listed');
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
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
