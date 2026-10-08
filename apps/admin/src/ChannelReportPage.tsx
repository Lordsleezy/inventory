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

export function ChannelReportPage({ client, money }: { client: SupabaseClient; money: (n: number) => string }) {
  const [start, setStart] = useState(() => { const d = new Date(); d.setDate(1); return day(d); });
  const [end, setEnd] = useState(() => day(new Date(Date.now() + 86400000)));
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

  const totals = report?.channels.reduce((t, c) => ({
    gross: t.gross + c.gross_cents, fees: t.fees + c.fee_cents, ship: t.ship + c.ship_cost_cents,
    proc: t.proc + c.processing_fee_cents, cost: t.cost + c.cost_cents,
    taxOwed: t.taxOwed + c.tax_owed_cents, taxCollected: t.taxCollected + c.tax_collected_cents,
    profit: t.profit + c.profit_cents,
  }), { gross: 0, fees: 0, ship: 0, proc: 0, cost: 0, taxOwed: 0, taxCollected: 0, profit: 0 });
  const net = totals ? totals.profit - (report?.expense_cents || 0) : 0;
  const refundTotal = report?.refunds.reduce((n, r) => n + r.sales_cents, 0) || 0;

  return <>
    <header><div><div className="eyebrow">PROFITABILITY</div><h1>Channels</h1>
      <p>Profit per sales channel: gross − channel fees − label/shipping cost − card processing − item cost. Tax is pass-through and never counted as profit. Estimated numbers are flagged and update automatically when real fees sync in.</p></div>
      <div className="report-actions">
        <label className="date-control">From<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
        <label className="date-control">To<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
      </div></header>
    {error && <div className="alert" role="alert">{error}</div>}
    {busy && !report ? <section className="panel"><div className="empty">Loading…</div></section> : report && totals && <>
      <div className="stats">
        <Stat name="Gross sales" value={money(totals.gross)} />
        <Stat name="Channel fees" value={money(totals.fees)} />
        <Stat name="Label / ship cost" value={money(totals.ship)} />
        <Stat name="Card processing" value={money(totals.proc)} />
        <Stat name="Item cost" value={money(totals.cost)} />
        <Stat name="Profit" value={money(totals.profit)} />
        <Stat name="Expenses" value={money(report.expense_cents)} />
        <Stat name="Net" value={money(net)} />
        <Stat name="Tax collected" value={money(totals.taxCollected)} />
        <Stat name="Tax we owe" value={money(totals.taxOwed)} />
        {refundTotal > 0 && <Stat name="Refunded" value={money(refundTotal)} />}
      </div>
      <section className="panel">
        <h2>By channel</h2>
        {report.channels.length === 0 ? <div className="empty">No sales in this range.</div> :
          <div className="table-wrap"><table>
            <thead><tr><th>Channel</th><th>Sales</th><th>Gross</th><th>Fees</th><th>Label cost</th><th>Card proc.</th><th>Item cost</th><th>Tax collected</th><th>vs ask</th><th>Profit</th><th>Margin</th></tr></thead>
            <tbody>{report.channels.map(c => <tr key={c.channel}>
              <td><strong>{c.channel}</strong>{c.cost_estimated_count > 0 && <small> · {c.cost_estimated_count} est. cost</small>}</td>
              <td>{c.sales_count}</td>
              <td>{money(c.gross_cents)}</td>
              <td>{money(c.fee_cents)}{c.fee_estimated_cents > 0 && c.fee_actual_cents === 0 ? <small> est.</small> : c.fee_estimated_cents > 0 ? <small> ({money(c.fee_estimated_cents)} est.)</small> : null}</td>
              <td>{money(c.ship_cost_cents)}</td>
              <td>{money(c.processing_fee_cents)}</td>
              <td>{money(c.cost_cents)}</td>
              <td>{money(c.tax_collected_cents)}{c.tax_owed_cents > 0 && <small> · owe {money(c.tax_owed_cents)}</small>}</td>
              <td>{c.variance_cents === null ? '—' : `${c.variance_cents > 0 ? '+' : '−'}${money(Math.abs(c.variance_cents))}`}</td>
              <td><strong>{money(c.profit_cents)}</strong></td>
              <td>{c.gross_cents > 0 ? `${(c.profit_cents / c.gross_cents * 100).toFixed(0)}%` : '—'}</td>
            </tr>)}</tbody>
          </table></div>}
      </section>
      {report.refunds.length > 0 && <section className="panel"><h2>Refunds in range</h2>
        <div className="table-wrap"><table><thead><tr><th>Channel</th><th>Count</th><th>Gross reversed</th><th>Profit reversed</th></tr></thead>
        <tbody>{report.refunds.map(r => <tr key={r.channel}><td>{r.channel}</td><td>{r.count}</td><td>{money(r.sales_cents)}</td><td>{money(r.profit_reversed_cents)}</td></tr>)}</tbody></table></div></section>}
      {report.expenses.length > 0 && <section className="panel"><h2>Expenses in range</h2>
        <div className="table-wrap"><table><thead><tr><th>Category</th><th>Amount</th></tr></thead>
        <tbody>{report.expenses.map(e => <tr key={e.category}><td>{e.category}</td><td>{money(e.cents)}</td></tr>)}</tbody>
        <tfoot><tr><td>Total</td><td>{money(report.expense_cents)}</td></tr></tfoot></table></div>
        {report.label_expense_cents > 0 && <p className="hint">Includes {money(report.label_expense_cents)} of shipping-label expenses, also counted in each sale’s label cost above.</p>}</section>}
    </>}
  </>;
}
function Stat({ name, value }: { name: string; value: string }) { return <div className="stat"><span>{name}</span><strong>{value}</strong></div>; }
