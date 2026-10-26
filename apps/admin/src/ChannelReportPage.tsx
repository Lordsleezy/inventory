import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type ChannelRow = {
  channel: string; sales_count: number; unmatched_count?: number; gross_cents: number;
  fee_cents: number; fee_actual_cents: number; fee_estimated_cents: number;
  ship_cost_cents: number; processing_fee_cents: number;
  tax_collected_cents: number; tax_owed_cents: number;
  cost_cents: number; cost_estimated_count: number;
  variance_cents: number | null; profit_cents: number;
};
type Report = {
  start: string; end: string; channels: ChannelRow[];
  refunds: { channel: string; count: number; sales_cents: number; profit_reversed_cents: number }[];
  expenses: { category: string; cents: number }[];
  expense_cents: number; label_expense_cents: number;
  ebay_overhead_cents?: number;
};
type DetailRow = {
  id: number | string; at: string; channel: string; sku: string | null;
  title: string | null; buyer: string | null; email: string | null;
  order_no: string | null; amount_cents: number; detail: string | null;
  reason: string | null; source: string | null;
};
type AdFees = { ad_fee_cents: number; attached_cents: number; unattached_cents: number; orders_with_ad_fee: number };
type MetricKey = 'gross' | 'fees' | 'ship' | 'processing' | 'cost' | 'profit' | 'expenses' | 'tax_collected' | 'refunds';

const METRIC_LABELS: Record<MetricKey, string> = {
  gross: 'Gross sales',
  fees: 'Channel fees',
  ship: 'Label / ship cost',
  processing: 'Card processing',
  cost: 'Item cost',
  profit: 'Profit',
  expenses: 'Expenses',
  tax_collected: 'Sales tax collected',
  refunds: 'Refunded',
};

const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const stamp = (s: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(s.length === 10 ? `${s}T12:00:00` : s));

const ALL_TIME_START = '2020-01-01';

export function ChannelReportPage({ client, money, embedded, mode = 'full', native, onLinkSku }: { client: SupabaseClient; money: (n: number) => string; embedded?: boolean; mode?: 'full' | 'fees'; native?: boolean; onLinkSku?: () => void }) {
  // Default to all-time so early floor sales (fridges, etc.) are not hidden behind "this month".
  const [start, setStart] = useState(() => native && mode === 'fees' ? day(new Date(new Date().getFullYear(), new Date().getMonth(), 1)) : ALL_TIME_START);
  const [end, setEnd] = useState(() => day(new Date(Date.now() + 86400000)));
  const [channel, setChannel] = useState('all');
  const [report, setReport] = useState<Report | null>(null);
  const [adFees, setAdFees] = useState<AdFees | null>(null);
  const requestId = useRef(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<MetricKey | null>(null);
  const [detailRows, setDetailRows] = useState<DetailRow[]>([]);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [range, setRange] = useState<'day' | 'week' | 'month' | 'all' | 'custom'>(native && mode === 'fees' ? 'month' : 'all');
  const [showDates, setShowDates] = useState(false);
  const [buyerShipping, setBuyerShipping] = useState<number | null>(null);
  const [buyerShippingError, setBuyerShippingError] = useState(false);
  const [missingCostCount, setMissingCostCount] = useState<number | null>(null);

  const load = useCallback(async (s: string, e: string) => {
    const id = ++requestId.current;
    setBusy(true); setError('');
    if (native) setReport(null);
    try {
      const [result, ads] = await Promise.all([
        client.rpc('portal_channel_report', { p_start: s, p_end: e }),
        // eBay Promoted Listings fees on their own line. Missing RPC (migration not applied yet) just hides the line.
        client.rpc('portal_ebay_ad_fee_report', { p_start: s, p_end: e }),
      ]);
      if (result.error) throw result.error;
      if (id === requestId.current) { setReport(result.data as Report); setAdFees(ads.error ? null : ads.data as AdFees); }
    } catch (x) { if (id === requestId.current) setError(x instanceof Error ? x.message : String(x)); }
    finally { if (id === requestId.current) setBusy(false); }
  }, [client, native]);

  useEffect(() => { void load(start, end); }, [load, start, end]);

  useEffect(() => {
    if (mode !== 'full' || native) return;
    let alive = true;
    setMissingCostCount(null);
    void (async () => {
      let count = 0;
      for (let offset = 0;; offset += 1000) {
        const { data, error: err } = await client.rpc('portal_payout_sales').range(offset, offset + 999);
        if (err) throw err;
        const rows = (data || []) as { sold_at: string; cost_cents: number | null; channel: string }[];
        count += rows.filter(r => r.cost_cents == null && r.sold_at.slice(0, 10) >= start && r.sold_at.slice(0, 10) < end &&
          (channel === 'all' || r.channel === channel)).length;
        if (rows.length < 1000) break;
      }
      if (alive) setMissingCostCount(count);
    })().catch(() => { if (alive) setMissingCostCount(null); });
    return () => { alive = false; };
  }, [client, start, end, channel, mode, native]);

  useEffect(() => {
    if (!native || mode !== 'fees') return;
    let alive = true;
    setBuyerShipping(null); setBuyerShippingError(false);
    const last = new Date(`${end}T12:00:00Z`); last.setUTCDate(last.getUTCDate() - 1);
    void Promise.resolve(client.rpc('portal_sale_tax_rows', { p_start: start, p_end: last.toISOString().slice(0,10) }))
      .then(({ data, error: err }) => {
        if (alive && !err) setBuyerShipping(((data as { rows?: { shipping_cents?: number }[] })?.rows || []).reduce((n, r) => n + Number(r.shipping_cents || 0), 0));
        else if (alive) setBuyerShippingError(true);
      }).catch(() => { if (alive) setBuyerShippingError(true); });
    return () => { alive = false; };
  }, [client, start, end, native, mode]);

  const openDrill = useCallback(async (metric: MetricKey) => {
    setDrill(metric); setDetailBusy(true); setDetailError(''); setDetailRows([]);
    try {
      const { data, error: err } = await client.rpc('portal_channel_report_detail', {
        p_start: start, p_end: end, p_metric: metric, p_channel: channel === 'all' ? null : channel,
      });
      if (err) throw err;
      setDetailRows(((data as { rows?: DetailRow[] })?.rows || []) as DetailRow[]);
    } catch (x) { setDetailError(x instanceof Error ? x.message : String(x)); }
    finally { setDetailBusy(false); }
  }, [client, start, end, channel]);

  useEffect(() => {
    if (!drill) return;
    void openDrill(drill);
  }, [channel, start, end, drill, openDrill]);

  function preset(kind: 'day' | 'week' | 'month' | 'all') {
    setRange(kind);
    const now = new Date();
    const endD = day(new Date(now.getTime() + 86400000));
    if (kind === 'all') { setStart(ALL_TIME_START); setEnd(endD); return; }
    if (kind === 'day') { setStart(day(now)); setEnd(endD); return; }
    if (kind === 'week') {
      const wd = now.getDay();
      const monday = new Date(now); monday.setDate(now.getDate() - ((wd + 6) % 7));
      setStart(day(monday)); setEnd(endD); return;
    }
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    setStart(day(first)); setEnd(endD);
  }

  const channels = (report?.channels || []).filter(c => channel === 'all' || c.channel === channel);
  const totals = channels.reduce((t, c) => ({
    gross: t.gross + c.gross_cents, fees: t.fees + c.fee_cents, ship: t.ship + c.ship_cost_cents,
    proc: t.proc + c.processing_fee_cents, cost: t.cost + c.cost_cents,
    taxCollected: t.taxCollected + c.tax_collected_cents,
    profit: t.profit + c.profit_cents,
    unmatched: t.unmatched + (c.unmatched_count || 0),
  }), { gross: 0, fees: 0, ship: 0, proc: 0, cost: 0, taxCollected: 0, profit: 0, unmatched: 0 });
  const refundTotal = (report?.refunds || []).filter(r => channel === 'all' || r.channel === channel)
    .reduce((n, r) => n + r.sales_cents, 0);
  const detailTotal = detailRows.reduce((n, r) => n + (r.amount_cents || 0), 0);
  const isAllTime = start === ALL_TIME_START;
  const ebayOverhead = report?.ebay_overhead_cents || 0;
  const unmatchedHint = totals.unmatched > 0
    ? `${totals.unmatched} unmatched Orders sale${totals.unmatched === 1 ? '' : 's'} included in gross/profit (item cost pending Link SKU). Marketplace payouts can look higher than linked Floor sales alone.`
    : 'Gross includes paid marketplace Orders that still need a Floor SKU link, so totals stay closer to channel payouts.';
  const ebayHint = (channel === 'ebay' || channel === 'all') && ebayOverhead > 0
    ? ` eBay profit includes −${money(ebayOverhead)} insertion/subscription.`
    : '';

  const dateControls = <div className="report-actions">
    <div className="actions">
      <button type="button" className={isAllTime ? undefined : 'secondary'} onClick={() => preset('all')}>All time</button>
      <button type="button" className="secondary" onClick={() => preset('day')}>Day</button>
      <button type="button" className="secondary" onClick={() => preset('week')}>Week</button>
      <button type="button" className="secondary" onClick={() => preset('month')}>Month</button>
    </div>
    <label className="date-control">From<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
    <label className="date-control">To<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
    <label className="date-control">Channel<select value={channel} onChange={e => setChannel(e.target.value)}>
      <option value="all">All channels</option>
      {(report?.channels || []).map(c => <option key={c.channel} value={c.channel}>{c.channel}</option>)}
    </select></label>
  </div>;
  if (native) {
    const period = range === 'all' ? 'All time' : range === 'day' ? 'Today' : range === 'week' ? 'This week' : range === 'month' ? 'This month' : `${start} – ${end}`;
    const row = (label: string, amount: number, metric: MetricKey, tone?: 'minus' | 'plus', strong?: boolean, note?: string) =>
      <button type="button" className={`native-report-row${strong ? ' strong' : ''}`} onClick={() => setDrill(metric)} key={label}>
        <span>{label}{note && <small>{note}</small>}</span><b className={tone || ''}>{tone === 'minus' ? '−' : tone === 'plus' ? '+' : ''}{money(Math.abs(amount))}</b><span className="native-chevron">›</span>
      </button>;
    return <div className="native-report-body">
      <div className="native-report-segment" role="group" aria-label="Date range">{(['day', 'week', 'month', 'all'] as const).map(k =>
        <button type="button" key={k} className={range === k ? 'selected' : ''} onClick={() => preset(k)}>{k === 'all' ? 'All' : k[0].toUpperCase() + k.slice(1)}</button>)}</div>
      <button type="button" className="native-report-period" onClick={() => setShowDates(v => !v)} aria-expanded={showDates}>{period} · {start} – {end} ▾</button>
      {showDates && <div className="native-report-dates"><label>From<input type="date" value={start} onChange={e => { setRange('custom'); setStart(e.target.value); }} /></label><label>To<input type="date" value={end} onChange={e => { setRange('custom'); setEnd(e.target.value); }} /></label></div>}
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="native-report-hero" aria-live="polite"><small>{mode === 'fees' ? 'Total shipping & fees' : 'Profit after cost & fees'} · {period}</small><strong>{report ? money(mode === 'fees' ? totals.ship + totals.fees + totals.proc : totals.profit) : <span className="native-skeleton" />}</strong><span>{report ? mode === 'fees' ? `${totals.gross ? (((totals.ship + totals.fees + totals.proc) / totals.gross) * 100).toFixed(1) : '0'}% of gross sales` : 'Sales less fees, shipping, processing, and item cost' : 'Loading report…'}</span></div>
      {!report && !error && <div className="native-report-group">{[0,1,2,3].map(i => <div className="native-skeleton-row" key={i}><span className="native-skeleton" /></div>)}</div>}
      {report && mode === 'full' && totals.unmatched > 0 && <button type="button" className="native-report-warning" onClick={onLinkSku}>{totals.unmatched} marketplace sale{totals.unmatched === 1 ? '' : 's'} need a SKU link. Item cost is pending. <b>Link SKUs ›</b></button>}
      {report && mode === 'full' && <><div className="native-report-group">
        {row('Gross sales', totals.gross, 'gross')}{row('Channel fees', totals.fees, 'fees', 'minus')}{row('Labels & shipping', totals.ship, 'ship', 'minus')}{row('Card processing', totals.proc, 'processing', 'minus')}{row('Sales tax collected', totals.taxCollected, 'tax_collected', 'minus', false, 'Pass-through, including marketplace-remitted tax')}{row('Item cost', totals.cost, 'cost', 'minus')}{row('Profit', totals.profit, 'profit', totals.profit < 0 ? 'minus' : undefined, true)}
      </div><p className="native-report-footnote">Gross includes item price, buyer-paid shipping and tax. Tax is removed before profit; see Sales tax for the amount your store owes.</p><h3 className="native-report-section">By channel</h3><div className="native-report-group">{channels.map(c => <button type="button" className="native-report-row" key={c.channel} onClick={() => { setChannel(c.channel); setDrill('profit'); }}><span><i className={`native-channel-dot channel-${c.channel.toLowerCase()}`} />{c.channel}<small>{c.channel === 'ebay' && ebayOverhead > 0 ? `Includes ${money(ebayOverhead)} insertion/subscription` : `${c.sales_count} sales`}</small></span><b>{money(c.profit_cents)}</b><span className="native-chevron">›</span></button>)}</div></>}
      {report && mode === 'fees' && <><h3 className="native-report-section">Shipping</h3><div className="native-report-group">{row('Labels bought', totals.ship, 'ship', 'minus')}{buyerShipping !== null && <div className="native-report-row"><span>{totals.unmatched ? 'Buyer shipping · linked sales' : 'Shipping paid by buyers'}</span><b className="plus">+{money(buyerShipping)}</b></div>}{buyerShipping !== null && totals.unmatched === 0 && <div className="native-report-row strong"><span>Shipping net</span><b className={buyerShipping >= totals.ship ? 'plus' : 'minus'}>{buyerShipping >= totals.ship ? '+' : '−'}{money(Math.abs(buyerShipping - totals.ship))}</b></div>}</div>{totals.unmatched > 0 && <p className="native-report-footnote">Shipping paid by buyers excludes {totals.unmatched} unmatched order{totals.unmatched === 1 ? '' : 's'}. A net figure would mix different sets of sales.</p>}{buyerShippingError && <p className="native-report-footnote">Buyer-paid shipping is unavailable from sale rows for this period.</p>}<h3 className="native-report-section">Channel fees</h3><div className="native-report-group">{channels.filter(c => c.fee_cents).map(c => <button type="button" className="native-report-row" key={c.channel} onClick={() => { setChannel(c.channel); setDrill('fees'); }}><span><i className={`native-channel-dot channel-${c.channel.toLowerCase()}`} />{c.channel}{c.channel === 'ebay' && ebayOverhead > 0 && <small>Includes {money(ebayOverhead)} insertion/subscription</small>}</span><b>{money(c.fee_cents)}</b><span className="native-chevron">›</span></button>)}</div>{adFees && channels.some(c => c.channel === 'ebay') && <div className="native-report-group"><div className="native-report-row"><span>eBay ad fees<small>Promoted Listings · included in eBay above</small></span><b className="minus">−{money(adFees.ad_fee_cents)}</b></div></div>}<h3 className="native-report-section">Card processing</h3><div className="native-report-group">{row('Square', totals.proc, 'processing', 'minus')}</div></>}
      {drill && <section className="native-report-detail"><button type="button" onClick={() => { setDrill(null); setChannel('all'); }}>‹ Back to report</button><h2>{METRIC_LABELS[drill]}</h2>{detailError && <p role="alert">{detailError}</p>}{detailBusy ? <div className="native-skeleton" /> : detailRows.length ? detailRows.map((r, i) => <div className="native-report-row" key={`${r.id}-${i}`}><span>{r.title || r.sku || r.channel}<small>{r.at ? stamp(r.at) : ''} · {r.detail || r.reason || ''}</small></span><b>{money(r.amount_cents || 0)}</b></div>) : <p>No rows in this range.</p>}</section>}
    </div>;
  }
  return <>
    {!embedded && mode === 'full' && <header><div><div className="eyebrow">PROFITABILITY</div><h1>Channels</h1>
      <p>Defaults to all-time (includes early floor sales). Gross includes collected tax, which is removed before profit. Profit also subtracts channel fees, label cost, card processing, and item cost. Click any total for the rows.</p></div>{dateControls}</header>}
    {!embedded && mode === 'fees' && <header><div><div className="eyebrow">SHIPPING & FEES</div><h1>Channel fees & labels</h1>
      <p>Marketplace fees, label spend, and card processing by channel. Click a total for the line items.</p></div>{dateControls}</header>}
    {embedded && <div className="section-head" style={{ marginBottom: 12, flexWrap: 'wrap' }}><div><h2>{mode === 'fees' ? 'Fees & label spend by channel' : 'Profit by channel'}</h2><p className="hint" style={{ margin: 0 }}>Click a total to see how it was calculated. {mode === 'full' ? `${unmatchedHint}${ebayHint}` : ''}</p></div>{dateControls}</div>}
    {error && <div className="alert" role="alert">{error}</div>}
    {busy && !report ? <section className="panel"><div className="empty">Loading…</div></section> : report && <>
      {mode === 'full' && totals.unmatched > 0 && <div className="alert" role="status">{unmatchedHint}</div>}
      {mode === 'full' && missingCostCount != null && missingCostCount > 0 && <div className="alert" role="status">{missingCostCount} sold item{missingCostCount === 1 ? ' has' : 's have'} cost missing. Enter a real cost in Inventory; no default cost is used in profit.</div>}
      {mode === 'full' && channel === 'ebay' && ebayOverhead > 0 && <div className="alert" role="status">Profit is after voided label spend and {money(ebayOverhead)} eBay insertion/subscription (same stack as the eBay tab and Payouts).</div>}
      <div className="stats">
        {mode === 'full' && <Stat name="Gross sales" value={money(totals.gross)} onClick={() => setDrill('gross')} active={drill === 'gross'} note="item + buyer shipping + tax" />}
        <Stat name="Channel fees" value={money(totals.fees)} onClick={() => setDrill('fees')} active={drill === 'fees'} />
        {mode === 'fees' && adFees && (channel === 'all' || channel === 'ebay') && (adFees.ad_fee_cents !== 0 || channels.some(c => c.channel === 'ebay')) &&
          <Stat name="eBay ad fees" value={money(adFees.ad_fee_cents)} note={`Promoted Listings · ${adFees.orders_with_ad_fee} sale${adFees.orders_with_ad_fee === 1 ? '' : 's'}${adFees.unattached_cents ? ` + ${money(adFees.unattached_cents)} campaign charges` : ''} · included in Channel fees`} />}
        <Stat name="Label / ship cost" value={money(totals.ship)} onClick={() => setDrill('ship')} active={drill === 'ship'} />
        <Stat name="Card processing" value={money(totals.proc)} onClick={() => setDrill('processing')} active={drill === 'processing'} />
        {mode === 'full' && <>
          <Stat name="Sales tax collected" value={money(totals.taxCollected)} onClick={() => setDrill('tax_collected')} active={drill === 'tax_collected'} note="Pass-through, not profit" />
          <Stat name="Item cost" value={money(totals.cost)} onClick={() => setDrill('cost')} active={drill === 'cost'} />
          <Stat name="Profit" value={money(totals.profit)} onClick={() => setDrill('profit')} active={drill === 'profit'} />
        </>}
        {mode === 'full' && refundTotal > 0 && <Stat name="Refunded" value={money(refundTotal)} onClick={() => setDrill('refunds')} active={drill === 'refunds'} />}
        {mode === 'fees' && channel === 'all' && report.label_expense_cents > 0 && <Stat name="Label expenses (ledger)" value={money(report.label_expense_cents)} onClick={() => setDrill('expenses')} active={drill === 'expenses'} />}
      </div>
      {drill && <section className="panel drilldown" aria-live="polite">
        <div className="section-head">
          <div>
            <div className="eyebrow">BREAKDOWN</div>
            <h2>{METRIC_LABELS[drill]} · {detailRows.length} row{detailRows.length === 1 ? '' : 's'} · {money(detailTotal)}</h2>
            <p className="hint" style={{ margin: 0 }}>{channel === 'all' ? 'All channels' : channel} · {start} → {end}</p>
          </div>
          <button type="button" className="text-button" onClick={() => setDrill(null)}>Close</button>
        </div>
        {detailError && <p className="error" role="alert">{detailError}</p>}
        {detailBusy ? <div className="empty">Loading rows…</div> : detailRows.length === 0 ? <div className="empty">No rows for this total in the selected range.</div> :
          <div className="table-wrap"><table>
            <thead><tr>
              <th>When</th><th>Channel</th><th>Item</th>
              {(drill === 'refunds' || drill === 'gross' || drill === 'profit' || drill === 'ship' || drill === 'fees') && <th>Buyer / order</th>}
              <th>Amount</th><th>Notes</th>
            </tr></thead>
            <tbody>{detailRows.map((r, i) => <tr key={`${r.id}-${i}`}>
              <td>{r.at ? stamp(r.at) : '—'}</td>
              <td>{r.channel || '—'}</td>
              <td><strong>{r.title || (r.sku ? `SKU ${r.sku}` : '—')}</strong>{r.sku && <small> · SKU {r.sku}</small>}</td>
              {(drill === 'refunds' || drill === 'gross' || drill === 'profit' || drill === 'ship' || drill === 'fees') &&
                <td>{r.buyer || r.email || '—'}{r.order_no ? <small> · {r.order_no}</small> : null}{r.email && r.buyer ? <small> · {r.email}</small> : null}</td>}
              <td><strong>{money(r.amount_cents || 0)}</strong></td>
              <td>{r.reason || r.detail || r.source || '—'}{r.reason && r.detail ? <small> · {r.detail}</small> : null}</td>
            </tr>)}</tbody>
          </table></div>}
      </section>}
    </>}
  </>;
}
function Stat({ name, value, onClick, active, note }: { name: string; value: string; onClick?: () => void; active?: boolean; note?: string }) {
  if (!onClick) return <div className="stat"><span>{name}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</div>;
  return <button type="button" className={`stat stat-button${active ? ' active' : ''}`} onClick={onClick}>
    <span>{name}</span><strong>{value}</strong><small>{note || 'View details'}</small>
  </button>;
}
