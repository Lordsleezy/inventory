import { useEffect, useMemo, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { StaffSession } from '@floor/cloud';
import { floorFunctionUrl } from '../floorApi';
import { MissingFieldPage } from '../MissingFieldPage';
import { MissingCostPage } from '../MissingCostPage';
import { ChannelReportPage } from '../ChannelReportPage';
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
  { kind: 'upc', label: 'No UPC', blocks: 'Amazon' },
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
        const { data } = await client.rpc('portal_sales', { p_start: day, p_end: day });
        if (alive) setSalesToday(Array.isArray(data) ? new Set((data as { ticket_id?: string }[]).map((r) => r.ticket_id)).size : 0);
      } catch { /* ignore */ }

      try {
        const token = session.access_token;
        const res = await fetch(floorFunctionUrl('listing-manager'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'board_catalog', channel: 'ebay' }),
        });
        const json = await res.json();
        if (alive && json?.listed) setEbayN(String(json.listed.length));
        if (alive && json?.last_synced?.at) {
          const mins = Math.max(0, Math.round((Date.now() - new Date(json.last_synced.at).getTime()) / 60000));
          setSync(mins < 1 ? 'Just now' : `${mins} min ago`);
        }
      } catch { /* ignore */ }

      try {
        const token = session.access_token;
        const res = await fetch(floorFunctionUrl('listing-manager'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'board_catalog', channel: 'amazon' }),
        });
        const json = await res.json();
        if (alive && json?.listed) setAmazonN(String(json.listed.length));
        if (alive && json?.connected === false) setAmazonN('Connect');
      } catch { /* ignore */ }

      try {
        const token = session.access_token;
        const res = await fetch(floorFunctionUrl('listing-manager'), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'board_catalog', channel: 'tiktok' }),
        });
        const json = await res.json();
        if (alive) setTiktokN(json?.connected === false ? 'Connect' : String(json?.listed?.length ?? 0));
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
        const { data, error: e } = await client.rpc('portal_sales', { p_start: start, p_end: end });
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

export function AppReportsNative({ client, money, onBack }: {
  client: SupabaseClient; money: (n: number) => string; onBack: () => void;
}) {
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
        <div className="app-nav-title">Reports</div>
        <button type="button" style={{ visibility: 'hidden' }}>·</button>
      </div>
      <div className="app-embed-soft">
        <ChannelReportPage client={client} money={money} embedded />
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
  onBack: () => void;
}) {
  return (
    <div className="app-stack">
      <div className="app-nav">
        <button type="button" onClick={onBack}>‹ More</button>
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
