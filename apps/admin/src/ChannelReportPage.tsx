import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type ChannelRow = {
  channel: string; sales_count: number; gross_cents: number;
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
};

const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

export function ChannelReportPage({ client, money, embedded, mode = 'full' }: { client: SupabaseClient; money: (n: number) => string; embedded?: boolean; mode?: 'full' | 'fees' }) {
  const [start, setStart] = useState(() => { const d = new Date(); d.setDate(1); return day(d); });
  const [end, setEnd] = useState(() => day(new Date(Date.now() + 86400000)));
  const [channel, setChannel] = useState('all');
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  function preset(kind: 'day' | 'week' | 'month') {
    const now = new Date();
    const endD = day(new Date(now.getTime() + 86400000));
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
    taxOwed: t.taxOwed + c.tax_owed_cents, taxCollected: t.taxCollected + c.tax_collected_cents,
    profit: t.profit + c.profit_cents,
  }), { gross: 0, fees: 0, ship: 0, proc: 0, cost: 0, taxOwed: 0, taxCollected: 0, profit: 0 });
  const net = report ? totals.profit - (channel === 'all' ? (report.expense_cents || 0) : 0) : 0;
  const refundTotal = (report?.refunds || []).filter(r => channel === 'all' || r.channel === channel)
    .reduce((n, r) => n + r.sales_cents, 0);

  const dateControls = <div className="report-actions">
    <div className="actions">
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
      <p>Profit per sales channel: gross − channel fees − label/shipping cost − card processing − item cost. Tax is pass-through and never counted as profit. Estimated numbers are flagged and update automatically when real fees sync in.</p></div>{dateControls}</header>}
    {!embedded && mode === 'fees' && <header><div><div className="eyebrow">SHIPPING &amp; FEES</div><h1>Channel fees &amp; labels</h1>
      <p>Marketplace fees, label spend, and card processing by channel for the selected range.</p></div>{dateControls}</header>}
    {embedded && <div className="section-head" style={{ marginBottom: 12, flexWrap: 'wrap' }}><div><h2>{mode === 'fees' ? 'Fees &amp; label spend by channel' : 'Profit by channel'}</h2></div>{dateControls}</div>}
    {error && <div className="alert" role="alert">{error}</div>}
    {busy && !report ? <section className="panel"><div className="empty">Loading…</div></section> : report && <>
      <div className="stats">
        {mode === 'full' && <Stat name="Gross sales" value={money(totals.gross)} />}
        <Stat name="Channel fees" value={money(totals.fees)} />
        <Stat name="Label / ship cost" value={money(totals.ship)} />
        <Stat name="Card processing" value={money(totals.proc)} />
        {mode === 'full' && <>
          <Stat name="Item cost" value={money(totals.cost)} />
          <Stat name="Profit" value={money(totals.profit)} />
          {channel === 'all' && <Stat name="Expenses" value={money(report.expense_cents)} />}
          <Stat name="Net" value={money(net)} />
        </>}
        <Stat name="Tax collected" value={money(totals.taxCollected)} />
        <Stat name="Tax we owe" value={money(totals.taxOwed)} />
        {mode === 'full' && refundTotal > 0 && <Stat name="Refunded" value={money(refundTotal)} />}
        {mode === 'fees' && channel === 'all' && report.label_expense_cents > 0 && <Stat name="Label expenses (ledger)" value={money(report.label_expense_cents)} />}
      </div>
      <section className="panel">
        <h2>By channel</h2>
        {channels.length === 0 ? <div className="empty">No sales in this range.</div> :
          <div className="table-wrap"><table>
            <thead><tr><th>Channel</th><th>Sales</th>{mode === 'full' && <th>Gross</th>}<th>Fees</th><th>Label cost</th><th>Card proc.</th>{mode === 'full' && <><th>Item cost</th><th>Tax collected</th><th>vs ask</th><th>Profit</th><th>Margin</th></>}</tr></thead>
            <tbody>{channels.map(c => <tr key={c.channel}>
              <td><strong>{c.channel}</strong>{mode === 'full' && c.cost_estimated_count > 0 && <small> · {c.cost_estimated_count} est. cost</small>}</td>
              <td>{c.sales_count}</td>
              {mode === 'full' && <td>{money(c.gross_cents)}</td>}
              <td>{money(c.fee_cents)}{c.fee_estimated_cents > 0 && c.fee_actual_cents === 0 ? <small> est.</small> : c.fee_estimated_cents > 0 ? <small> ({money(c.fee_estimated_cents)} est.)</small> : null}</td>
              <td>{money(c.ship_cost_cents)}</td>
              <td>{money(c.processing_fee_cents)}</td>
              {mode === 'full' && <>
                <td>{money(c.cost_cents)}</td>
                <td>{money(c.tax_collected_cents)}{c.tax_owed_cents > 0 && <small> · owe {money(c.tax_owed_cents)}</small>}</td>
                <td>{c.variance_cents === null ? '—' : `${c.variance_cents > 0 ? '+' : '−'}${money(Math.abs(c.variance_cents))}`}</td>
                <td><strong>{money(c.profit_cents)}</strong></td>
                <td>{c.gross_cents > 0 ? `${(c.profit_cents / c.gross_cents * 100).toFixed(0)}%` : '—'}</td>
              </>}
            </tr>)}</tbody>
          </table></div>}
      </section>
      {mode === 'full' && report.refunds.filter(r => channel === 'all' || r.channel === channel).length > 0 && <section className="panel"><h2>Refunds in range</h2>
        <div className="table-wrap"><table><thead><tr><th>Channel</th><th>Count</th><th>Gross reversed</th><th>Profit reversed</th></tr></thead>
        <tbody>{report.refunds.filter(r => channel === 'all' || r.channel === channel).map(r => <tr key={r.channel}><td>{r.channel}</td><td>{r.count}</td><td>{money(r.sales_cents)}</td><td>{money(r.profit_reversed_cents)}</td></tr>)}</tbody></table></div></section>}
      {mode === 'full' && channel === 'all' && report.expenses.length > 0 && <section className="panel"><h2>Expenses in range</h2>
        <div className="table-wrap"><table><thead><tr><th>Category</th><th>Amount</th></tr></thead>
        <tbody>{report.expenses.map(e => <tr key={e.category}><td>{e.category}</td><td>{money(e.cents)}</td></tr>)}</tbody>
        <tfoot><tr><td>Total</td><td>{money(report.expense_cents)}</td></tr></tfoot></table></div>
        {report.label_expense_cents > 0 && <p className="hint">Includes {money(report.label_expense_cents)} of shipping-label expenses, also counted in each sale’s label cost above.</p>}</section>}
    </>}
  </>;
}
function Stat({ name, value }: { name: string; value: string }) { return <div className="stat"><span>{name}</span><strong>{value}</strong></div>; }
