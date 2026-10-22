import { useCallback, useEffect, useState } from 'react';
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
type MetricKey = 'gross' | 'fees' | 'ship' | 'processing' | 'cost' | 'profit' | 'expenses' | 'net' | 'tax_collected' | 'refunds';

const METRIC_LABELS: Record<MetricKey, string> = {
  gross: 'Gross sales',
  fees: 'Channel fees',
  ship: 'Label / ship cost',
  processing: 'Card processing',
  cost: 'Item cost',
  profit: 'Profit',
  expenses: 'Expenses',
  net: 'Net',
  tax_collected: 'Tax collected',
  refunds: 'Refunded',
};

const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const stamp = (s: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(s.length === 10 ? `${s}T12:00:00` : s));

const ALL_TIME_START = '2020-01-01';

export function ChannelReportPage({ client, money, embedded, mode = 'full' }: { client: SupabaseClient; money: (n: number) => string; embedded?: boolean; mode?: 'full' | 'fees' }) {
  // Default to all-time so early floor sales (fridges, etc.) are not hidden behind "this month".
  const [start, setStart] = useState(ALL_TIME_START);
  const [end, setEnd] = useState(() => day(new Date(Date.now() + 86400000)));
  const [channel, setChannel] = useState('all');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<MetricKey | null>(null);
  const [detailRows, setDetailRows] = useState<DetailRow[]>([]);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');

  const load = useCallback(async (s: string, e: string) => {
    setBusy(true); setError('');
    try {
      const { data, error: err } = await client.rpc('portal_channel_report', { p_start: s, p_end: e });
      if (err) throw err;
      setReport(data as Report);
    } catch (x) { setError(x instanceof Error ? x.message : String(x)); }
    finally { setBusy(false); }
  }, [client]);

  useEffect(() => { void load(start, end); }, [load, start, end]);

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
  // expense_cents excludes Shippo/manual labels (already in Label / ship cost + profit).
  const net = report ? totals.profit - (channel === 'all' ? (report.expense_cents || 0) : 0) : 0;
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
  return <>
    {!embedded && mode === 'full' && <header><div><div className="eyebrow">PROFITABILITY</div><h1>Channels</h1>
      <p>Defaults to all-time (includes early floor sales). Profit = item + buyer shipping − channel fees − label cost − card processing − item cost. Click any total for the rows.</p></div>{dateControls}</header>}
    {!embedded && mode === 'fees' && <header><div><div className="eyebrow">SHIPPING & FEES</div><h1>Channel fees & labels</h1>
      <p>Marketplace fees, label spend, and card processing by channel. Click a total for the line items.</p></div>{dateControls}</header>}
    {embedded && <div className="section-head" style={{ marginBottom: 12, flexWrap: 'wrap' }}><div><h2>{mode === 'fees' ? 'Fees & label spend by channel' : 'Profit by channel'}</h2><p className="hint" style={{ margin: 0 }}>Click a total to see how it was calculated. {mode === 'full' ? `${unmatchedHint}${ebayHint}` : ''}</p></div>{dateControls}</div>}
    {error && <div className="alert" role="alert">{error}</div>}
    {busy && !report ? <section className="panel"><div className="empty">Loading…</div></section> : report && <>
      {mode === 'full' && totals.unmatched > 0 && <div className="alert" role="status">{unmatchedHint}</div>}
      {mode === 'full' && channel === 'ebay' && ebayOverhead > 0 && <div className="alert" role="status">Profit is after voided label spend and {money(ebayOverhead)} eBay insertion/subscription (same stack as the eBay tab and Payouts).</div>}
      <div className="stats">
        {mode === 'full' && <Stat name="Gross sales" value={money(totals.gross)} onClick={() => setDrill('gross')} active={drill === 'gross'} note="item + buyer shipping · tax is separate" />}
        <Stat name="Channel fees" value={money(totals.fees)} onClick={() => setDrill('fees')} active={drill === 'fees'} />
        <Stat name="Label / ship cost" value={money(totals.ship)} onClick={() => setDrill('ship')} active={drill === 'ship'} />
        <Stat name="Card processing" value={money(totals.proc)} onClick={() => setDrill('processing')} active={drill === 'processing'} />
        {mode === 'full' && <>
          <Stat name="Item cost" value={money(totals.cost)} onClick={() => setDrill('cost')} active={drill === 'cost'} />
          <Stat name="Profit" value={money(totals.profit)} onClick={() => setDrill('profit')} active={drill === 'profit'} />
          {channel === 'all' && <Stat name="Expenses" value={money(report.expense_cents)} onClick={() => setDrill('expenses')} active={drill === 'expenses'} />}
          <Stat name="Net" value={money(net)} onClick={() => setDrill('net')} active={drill === 'net'} />
        </>}
        <Stat name="Tax collected" value={money(totals.taxCollected)} onClick={() => setDrill('tax_collected')} active={drill === 'tax_collected'} />
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
