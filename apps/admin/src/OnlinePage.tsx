import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OnlineChannel, OnlineTab } from './navigation';

type Row = {
  sku: string;
  title: string;
  brand: string | null;
  model: string | null;
  state?: string;
  ask_cents: number | null;
  listed_on: string[];
  reasons?: string[];
  missing?: string[];
  qty?: number;
  is_lot?: boolean;
  sold_at?: string | null;
  sold_channel?: string | null;
  sold_price_cents?: number | null;
  needs_sku?: boolean;
  match_status?: string | null;
  order_no?: string | null;
};

type PlatformReport = {
  channel: string;
  listed: number;
  sold: number;
  sold_cents: number;
};

type OnlineReport = {
  month_label: string;
  all_time?: boolean;
  year?: number | null;
  month?: number | null;
  listed_mode?: 'live_now' | 'put_up_in_period' | 'future';
  by_platform?: PlatformReport[];
  sold_total_this_month: number;
  sold_cents_total?: number;
  currently_listed_total: number;
  available_years?: number[];
};

type Board = {
  channels: string[];
  inventory_total?: number;
  listed: Row[];
  ready: Row[];
  not_ready: Row[];
  not_listable?: Row[];
  facebook_only?: Row[];
  msc: Row[];
  sold: Row[];
};

type ChannelCounts = Partial<Record<OnlineChannel | 'listed_unique', number>>;

type ReportPeriod =
  | { mode: 'all' }
  | { mode: 'month'; year: number; month: number };

type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
  tab: OnlineTab;
  onTab: (t: OnlineTab) => void;
  channel: OnlineChannel;
  onChannel: (c: OnlineChannel) => void;
  onInventory: () => void;
};

const CHANNELS: { key: Exclude<OnlineChannel, 'all'>; label: string }[] = [
  { key: 'ebay', label: 'eBay' },
  { key: 'depop', label: 'Depop' },
  { key: 'amazon', label: 'Amazon' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'facebook', label: 'Facebook' },
];

/** Report platforms — includes retired sale channels for sold history. */
const REPORT_CHANNELS: { key: string; label: string }[] = [
  { key: 'ebay', label: 'eBay' },
  { key: 'depop', label: 'Depop' },
  { key: 'amazon', label: 'Amazon' },
  { key: 'tiktok', label: 'TikTok' },
  { key: 'website', label: 'Website' },
  { key: 'mercari', label: 'Mercari' },
  { key: 'whatnot', label: 'Whatnot' },
  { key: 'facebook', label: 'Facebook' },
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const CHANNEL_LABEL: Record<string, string> = Object.fromEntries([
  ...REPORT_CHANNELS.map(c => [c.key, c.label] as const),
  ['web', 'Website'] as const,
]);

function labelChannel(key: string) {
  return CHANNEL_LABEL[key] || key;
}

function skuLabel(r: Row) {
  const qty = r.qty && r.qty > 1 ? ` (├ù${r.qty})` : '';
  return `SKU ${r.sku}${qty}`;
}

function currentPtPeriod(): ReportPeriod {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: 'numeric',
  }).formatToParts(new Date());
  const year = Number(parts.find(p => p.type === 'year')?.value);
  const month = Number(parts.find(p => p.type === 'month')?.value);
  return { mode: 'month', year, month };
}

export function OnlinePage({
  client, money, tab, onTab, channel, onChannel, onInventory,
}: Props) {
  const [board, setBoard] = useState<Board | null>(null);
  const [report, setReport] = useState<OnlineReport | null>(null);
  const [channelCounts, setChannelCounts] = useState<ChannelCounts>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState<ReportPeriod>(() => currentPtPeriod());

  async function loadReport(nextPeriod: ReportPeriod) {
    const args = nextPeriod.mode === 'all'
      ? { p_year: null, p_month: null }
      : { p_year: nextPeriod.year, p_month: nextPeriod.month };
    const reportRes = await client.rpc('portal_online_report', args);
    if (reportRes.error) throw reportRes.error;
    setReport(reportRes.data as OnlineReport);
  }

  async function load(opts?: { quiet?: boolean }) {
    if (!opts?.quiet) setLoading(true);
    setError('');
    try {
      const [boardRes, soldRes, countsRes] = await Promise.all([
        client.rpc('portal_online_board'),
        client.rpc('portal_online_sold', { p_limit: 500 }),
        client.rpc('portal_online_channel_counts'),
      ]);
      if (boardRes.error) throw boardRes.error;
      if (soldRes.error) throw soldRes.error;
      if (countsRes.error) throw countsRes.error;
      const next = boardRes.data as Board;
      const facebookOnly = next.facebook_only || next.not_listable || [];
      setBoard({
        channels: next.channels || CHANNELS.map(c => c.key),
        inventory_total: Number(next.inventory_total) || 0,
        listed: next.listed || [],
        ready: next.ready || [],
        not_ready: next.not_ready || [],
        facebook_only: facebookOnly,
        msc: next.msc || [],
        sold: (soldRes.data as Row[]) || [],
      });
      setChannelCounts((countsRes.data || {}) as ChannelCounts);
      await loadReport(period);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts?.quiet) setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [client]);

  useEffect(() => {
    if (tab !== 'reports') return;
    void loadReport(period).catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [period, tab, client]);

  useEffect(() => {
    const quiet = () => { void load({ quiet: true }); };
    const timer = window.setInterval(quiet, 30000);
    const channelLive = client
      .channel('online-board-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, quiet)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'listings' }, quiet)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'units' }, quiet)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'web_orders' }, quiet)
      .subscribe();
    return () => {
      window.clearInterval(timer);
      void client.removeChannel(channelLive);
    };
  }, [client]);

  const unitCount = (rows: Row[] | undefined) =>
    (rows || []).reduce((n, r) => n + Math.max(1, r.qty || 1), 0);

  const facebookOnlyCount = unitCount(board?.facebook_only);
  const readyCount = unitCount(board?.ready);
  const notReadyCount = unitCount(board?.not_ready);
  const mscCount = unitCount(board?.msc);
  const soldCount = unitCount(board?.sold);

  const counts = {
    inventory: board?.inventory_total || 0,
    listed: Number(channelCounts.listed_unique) || (board?.listed || []).length,
    ready: readyCount,
    notReady: notReadyCount,
    facebookOnly: facebookOnlyCount,
    msc: mscCount,
    sold: soldCount,
  };

  const subtabCount = (c: OnlineChannel) => {
    if (c === 'all') return counts.listed;
    if (c === 'facebook') return counts.facebookOnly;
    return channelCounts[c] || 0;
  };

  const listedForChannel = useMemo(() => {
    if (channel === 'facebook') return board?.facebook_only || [];
    if (channel === 'all') return board?.listed || [];
    const rows = board?.listed || [];
    return rows.filter(r => (r.listed_on || []).includes(channel));
  }, [board, channel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (r: Row) => {
      if (!q) return true;
      return [r.sku, r.title, r.brand, r.model, r.sold_channel, ...(r.reasons || []), ...(r.missing || [])]
        .filter(Boolean)
        .some(x => String(x).toLowerCase().includes(q));
    };
    if (tab === 'listed') return listedForChannel.filter(match);
    if (tab === 'ready') return (board?.ready || []).filter(match);
    if (tab === 'not-ready') return (board?.not_ready || []).filter(match);
    if (tab === 'sold') return (board?.sold || []).filter(match);
    if (tab === 'reports') return [];
    return (board?.msc || []).filter(match);
  }, [board, tab, listedForChannel, query]);

  const platformRows = useMemo(() => {
    const fromApi = report?.by_platform || [];
    const map = new Map(fromApi.map(r => [r.channel, r]));
    const base = REPORT_CHANNELS.map(c => map.get(c.key) || {
      channel: c.key,
      listed: c.key === 'facebook' || c.key === 'website' ? 0 : (channelCounts[c.key as OnlineChannel] || 0),
      sold: 0,
      sold_cents: 0,
    });
    // Any other online channels returned by the API (keep totals honest).
    for (const row of fromApi) {
      if (!base.some(b => b.channel === row.channel)) base.push(row);
    }
    return base;
  }, [report, channelCounts]);

  const soldFromTable = useMemo(
    () => platformRows.reduce((n, r) => n + (Number(r.sold) || 0), 0),
    [platformRows],
  );
  const revenueFromTable = useMemo(
    () => platformRows.reduce((n, r) => n + (Number(r.sold_cents) || 0), 0),
    [platformRows],
  );

  const yearOptions = useMemo(() => {
    const fromApi = report?.available_years || [];
    const cur = currentPtPeriod();
    const years = new Set<number>(fromApi);
    if (cur.mode === 'month') years.add(cur.year);
    if (period.mode === 'month') years.add(period.year);
    return [...years].sort((a, b) => b - a);
  }, [report, period]);

  const showingFacebookOnly = tab === 'listed' && channel === 'facebook';
  const showingAllListed = tab === 'listed' && channel === 'all';
  const onQueuePage = tab === 'ready' || tab === 'not-ready' || tab === 'msc' || tab === 'sold';
  const soldLabel = period.mode === 'all' ? 'Sold (all time)' : 'Sold';
  const listedFromTable = useMemo(
    () => platformRows.reduce((n, r) => n + (Number(r.listed) || 0), 0),
    [platformRows],
  );
  const listedTotal = report?.currently_listed_total ?? listedFromTable;
  const listedLabel = report?.listed_mode === 'put_up_in_period'
    ? 'Listed (that month)'
    : report?.listed_mode === 'future'
      ? 'Listed (not yet)'
      : period.mode === 'all'
        ? 'Listed now'
        : 'Listed now';
  const listedHint = report?.listed_mode === 'put_up_in_period'
    ? 'Listed = listings stamped in that month (0 before the tracker existed). Sold / revenue are for the same period.'
    : report?.listed_mode === 'future'
      ? 'Future months show 0 until that month starts ΓÇö then Listed updates live automatically.'
      : 'Listed = live on each platform right now (updates live). Sold / revenue cover the selected period (online only).';

  return <>
    <header>
      <div>
        <div className="eyebrow">CROSSLIST BOARD</div>
        <h1>Online</h1>
        <p>
          Click a tracker to open its page. Channel tabs show live listings.
          Reports show listed now and online sales for the period you pick.
        </p>
      </div>
      <button type="button" className="secondary" disabled={loading} onClick={() => void load()}>
        {loading ? 'LoadingΓÇª' : 'Refresh'}
      </button>
    </header>

    {error && <div className="alert" role="alert">{error}<button type="button" onClick={() => setError('')}>Dismiss</button></div>}

    <div className="stats">
      <button type="button" className="stat stat-link" onClick={onInventory}>
        <span>Total inventory</span><strong>{counts.inventory}</strong>
      </button>
      <button type="button" className={`stat stat-link${showingAllListed ? ' active' : ''}`} onClick={() => onChannel('all')}>
        <span>Listed (ΓëÑ1 channel)</span><strong>{counts.listed}</strong>
      </button>
      <button type="button" className={`stat stat-link${tab === 'ready' ? ' active' : ''}`} onClick={() => onTab('ready')}>
        <span>Ready to list</span><strong>{counts.ready}</strong>
      </button>
      <button type="button" className={`stat stat-link${tab === 'not-ready' ? ' active' : ''}`} onClick={() => onTab('not-ready')}>
        <span>Not ready</span><strong>{counts.notReady}</strong>
      </button>
      <button type="button" className={`stat stat-link${showingFacebookOnly ? ' active' : ''}`} onClick={() => onChannel('facebook')}>
        <span>Facebook only</span><strong>{counts.facebookOnly}</strong>
      </button>
      <button type="button" className={`stat stat-link${tab === 'msc' ? ' active' : ''}`} onClick={() => onTab('msc')}>
        <span>MSC</span><strong>{counts.msc}</strong>
      </button>
      <button type="button" className={`stat stat-link${tab === 'sold' ? ' active' : ''}`} onClick={() => onTab('sold')}>
        <span>Sold</span><strong>{counts.sold}</strong>
      </button>
    </div>

    {!onQueuePage && (
      <div className="inventory-tabs report-tabs online-channel-tabs">
        {CHANNELS.map(c => (
          <button
            type="button"
            key={c.key}
            className={tab === 'listed' && channel === c.key ? 'active' : ''}
            onClick={() => onChannel(c.key)}
          >
            {c.label}
            <small> {subtabCount(c.key)}</small>
          </button>
        ))}
        <button type="button" className={tab === 'reports' ? 'active' : ''} onClick={() => onTab('reports')}>
          Reports
        </button>
      </div>
    )}

    {onQueuePage && (
      <div className="inventory-tabs report-tabs">
        <button type="button" className="secondary" onClick={() => onChannel('all')}>
          ΓåÉ Back to Online
        </button>
      </div>
    )}

    {tab === 'reports' ? (
      <section className="panel">
        <div className="section-head" style={{ marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>Online reports ┬╖ {report?.month_label || 'ΓÇª'}</h2>
            <p className="hint" style={{ margin: '6px 0 0' }}>{listedHint}</p>
          </div>
          <div className="online-report-period">
            <label className="date-control">Period
              <select
                value={period.mode === 'all' ? 'all' : 'month'}
                onChange={e => {
                  if (e.target.value === 'all') setPeriod({ mode: 'all' });
                  else {
                    const cur = currentPtPeriod();
                    setPeriod(cur.mode === 'month' ? cur : { mode: 'month', year: new Date().getFullYear(), month: 1 });
                  }
                }}
              >
                <option value="month">Month</option>
                <option value="all">All time</option>
              </select>
            </label>
            {period.mode === 'month' && <>
              <label className="date-control">Month
                <select
                  value={period.month}
                  onChange={e => setPeriod({ mode: 'month', year: period.year, month: Number(e.target.value) })}
                >
                  {MONTHS.map((name, i) => (
                    <option key={name} value={i + 1}>{name}</option>
                  ))}
                </select>
              </label>
              <label className="date-control">Year
                <select
                  value={period.year}
                  onChange={e => setPeriod({ mode: 'month', year: Number(e.target.value), month: period.month })}
                >
                  {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </label>
            </>}
          </div>
        </div>
        {!report && loading ? <div className="empty">LoadingΓÇª</div> : <>
          <div className="stats" style={{ marginBottom: 18 }}>
            <div className="stat"><span>{listedLabel}</span><strong>{listedTotal}</strong></div>
            <div className="stat"><span>{soldLabel}</span><strong>{soldFromTable}</strong></div>
            <div className="stat"><span>Revenue</span><strong>{money(revenueFromTable)}</strong></div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Platform</th>
                <th>Listed</th>
                <th>Sold</th>
                <th>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {platformRows.map(r => (
                <tr key={r.channel}>
                  <td>{labelChannel(r.channel)}</td>
                  <td>{r.listed}</td>
                  <td>{r.sold}</td>
                  <td>{money(Number(r.sold_cents) || 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>}
      </section>
    ) : (
      <section className="panel">
        <div className="section-head" style={{ marginBottom: 12 }}>
          <div>
            <h2 style={{ margin: 0 }}>
              {showingAllListed && 'Listed ┬╖ every channel'}
              {tab === 'listed' && !showingFacebookOnly && !showingAllListed && `${labelChannel(channel)} ┬╖ currently listed`}
              {showingFacebookOnly && 'Facebook only ┬╖ oversized / local'}
              {tab === 'ready' && 'Ready to list'}
              {tab === 'not-ready' && 'Not ready to list'}
              {tab === 'msc' && 'MSC ┬╖ on eBay, missing other channels'}
              {tab === 'sold' && 'Sold online'}
            </h2>
            <p className="hint" style={{ margin: '6px 0 0' }}>
              {showingAllListed && `${counts.listed} unique items live on at least one marketplace. Quantity lots show once with (├ùN) remaining in stock.`}
              {tab === 'listed' && !showingFacebookOnly && !showingAllListed && `${subtabCount(channel)} active on ${labelChannel(channel)}. Quantity lots show once with (├ùN) remaining in stock.`}
              {showingFacebookOnly && 'Fridges, scooters, sofas, mattresses, dishwashers, commercial fryers, beds ΓÇö local Facebook Marketplace only.'}
              {tab === 'ready' && 'In stock with photo, price, cost, specs, and eBay eligibility ΓÇö and not already on eBay. Quantity lots already listed as one unit are excluded.'}
              {tab === 'not-ready' && 'Shippable units missing photo, price, cost, specs, or eligibility ΓÇö fix these before listing.'}
              {tab === 'msc' && 'Listed on eBay but missing Depop, Amazon, and/or TikTok (Facebook ignored for MSC).'}
              {tab === 'sold' && 'Online marketplace and website sales only ΓÇö in-store / Floor sales are excluded.'}
            </p>
          </div>
          <label className="date-control">Search
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="SKU, title, reasonΓÇª" />
          </label>
        </div>

        {loading && !board ? <div className="empty">LoadingΓÇª</div>
          : filtered.length === 0 ? <div className="empty">Nothing in this list.</div>
          : <div className="ticket-list">
            {filtered.map(r => (
              <div className="ticket" key={`${r.sku}-${r.is_lot ? 'lot' : 'unit'}-${r.sold_at || ''}-${r.order_no || ''}`}>
                <div className="ticket-top">
                  <strong>{r.title}{r.qty && r.qty > 1 ? ` (×${r.qty})` : ''}{r.needs_sku ? <small className="ticket-profit"> · needs SKU</small> : null}</strong>
                  <span>
                    {skuLabel(r)}
                    {tab === 'sold'
                      ? (r.sold_price_cents != null ? ` · ${money(r.sold_price_cents)}` : r.ask_cents != null ? ` · ${money(r.ask_cents)}` : ' · No price')
                      : (r.ask_cents != null ? ` · ${money(r.ask_cents)}` : ' · No price')}
                    {tab === 'sold' && r.sold_channel ? ` · ${labelChannel(r.sold_channel)}` : ''}
                    {tab !== 'sold' && r.state && r.state !== 'available' ? ` · ${r.state}` : ''}
                    {r.is_lot ? ' · quantity lot' : ''}
                    {r.needs_sku ? <b className="badge"> UNMATCHED</b> : null}
                  </span>
                </div>
                {tab === 'sold' && r.sold_at && (
                  <small>Sold {new Date(r.sold_at).toLocaleString()}{r.needs_sku ? ' · link SKU in Orders / Live Sales to attach inventory' : ''}</small>
                )}
                {tab !== 'sold' && !showingFacebookOnly && (r.listed_on?.length || 0) > 0 && (
                  <small>On: {r.listed_on.map(labelChannel).join(' ┬╖ ')}</small>
                )}
                {(showingFacebookOnly || tab === 'ready' || tab === 'not-ready') && (r.reasons?.length || 0) > 0 && (
                  <div className="online-reasons">
                    {r.reasons!.map(reason => <span key={reason}>{reason}</span>)}
                  </div>
                )}
                {tab === 'msc' && (r.missing?.length || 0) > 0 && (
                  <div className="online-reasons missing">
                    Missing: {r.missing!.map(labelChannel).join(' ┬╖ ')}
                  </div>
                )}
              </div>
            ))}
          </div>}
      </section>
    )}
  </>;
}
