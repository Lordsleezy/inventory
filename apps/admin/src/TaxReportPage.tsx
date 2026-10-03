import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = { category: string; sales_count: number; sales_cents: number; taxable_cents: number; tax_cents: number; shipping_cents: number;
  refund_count: number; refund_sales_cents: number; refund_taxable_cents: number; refund_tax_cents: number; refund_shipping_cents: number };
type Report = { month: string; origin_state: string; rows: Row[] };
type Props = { client: SupabaseClient; money: (n: number) => string };

const zone = 'America/Los_Angeles';
const thisMonth = () => new Date().toLocaleDateString('en-CA', { timeZone: zone }).slice(0, 7);
const dollars = (n: number) => (n / 100).toFixed(2);

/** One month of sales tax facts for the accountant: in-store, pickup, ship in-state, ship out of state; refunds; CSV. */
export function TaxReportPage({ client, money }: Props) {
  const [month, setMonth] = useState(thisMonth());
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    const { data, error: e } = await client.rpc('portal_tax_report', { p_month: `${month}-01` });
    if (e) { setError(e.message); setReport(null); return; }
    setReport(data as Report);
  }, [client, month]);
  useEffect(() => { void load(); }, [load]);

  const label = (c: string) => ({ in_store: 'In-store', pickup: 'Website — store pickup', ship_in_state: `Website — shipped to ${report?.origin_state ?? 'CA'}`, ship_out_of_state: 'Website — shipped out of state', other_online: 'Other online channels' } as Record<string, string>)[c] || c;
  const rows = report?.rows ?? [];
  const sum = (k: keyof Row) => rows.reduce((n, r) => n + Number(r[k]), 0);
  const net = (r: Row) => ({ sales: r.sales_cents - r.refund_sales_cents, taxable: r.taxable_cents - r.refund_taxable_cents, tax: r.tax_cents - r.refund_tax_cents });

  function csv() {
    const head = ['Month', 'Category', 'Sales (count)', 'Sales $', 'Taxable sales $', 'Non-taxable sales $', 'Tax collected $', 'Shipping charged $ (not in sales)', 'Refunds (count)', 'Refunded sales $', 'Refunded taxable $', 'Refunded tax $', 'Net sales $', 'Net taxable sales $', 'Net tax $'];
    const body = rows.map(r => { const n = net(r); return [report!.month, label(r.category), r.sales_count, dollars(r.sales_cents), dollars(r.taxable_cents), dollars(r.sales_cents - r.taxable_cents), dollars(r.tax_cents), dollars(r.shipping_cents), r.refund_count, dollars(r.refund_sales_cents), dollars(r.refund_taxable_cents), dollars(r.refund_tax_cents), dollars(n.sales), dollars(n.taxable), dollars(n.tax)]; });
    const t = ['TOTAL', sum('sales_count'), dollars(sum('sales_cents')), dollars(sum('taxable_cents')), dollars(sum('sales_cents') - sum('taxable_cents')), dollars(sum('tax_cents')), dollars(sum('shipping_cents')), sum('refund_count'), dollars(sum('refund_sales_cents')), dollars(sum('refund_taxable_cents')), dollars(sum('refund_tax_cents')), dollars(sum('sales_cents') - sum('refund_sales_cents')), dollars(sum('taxable_cents') - sum('refund_taxable_cents')), dollars(sum('tax_cents') - sum('refund_tax_cents'))];
    const lines = [head, ...body, [report!.month, ...t]].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','));
    const url = URL.createObjectURL(new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = `open-box-sales-tax-${report!.month}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  return <>
    <header><div><div className="eyebrow">REPORTS</div><h1>Sales tax</h1><p>Sales, taxable sales and tax collected for the month, split by how it was sold. Refunds are sales canceled that month. Shipping fees are shown separately.</p></div>
      <div className="report-actions"><label className="date-control">Month<input type="month" value={month} onChange={e => setMonth(e.target.value || thisMonth())} /></label>
        <div className="actions"><button className="secondary" disabled={!rows.length} onClick={csv}>Download CSV</button></div></div></header>
    {error && <div className="alert" role="alert">{error}</div>}
    <section className="panel"><h2>Sales — {report?.month ?? month}</h2>
      {!rows.length ? <div className="empty">No sales or refunds this month.</div> : <table className="tbl"><thead><tr><th>Sold as</th><th className="n">Sales</th><th className="n">Taxable sales</th><th className="n">Non-taxable</th><th className="n">Tax collected</th><th className="n">Shipping charged</th></tr></thead><tbody>
        {rows.map(r => <tr key={r.category}><td>{label(r.category)} <span className="tag">{r.sales_count}</span></td><td className="n">{money(r.sales_cents)}</td><td className="n">{money(r.taxable_cents)}</td><td className="n">{money(r.sales_cents - r.taxable_cents)}</td><td className="n">{money(r.tax_cents)}</td><td className="n">{money(r.shipping_cents)}</td></tr>)}
        <tr className="total"><td>Total</td><td className="n">{money(sum('sales_cents'))}</td><td className="n">{money(sum('taxable_cents'))}</td><td className="n">{money(sum('sales_cents') - sum('taxable_cents'))}</td><td className="n">{money(sum('tax_cents'))}</td><td className="n">{money(sum('shipping_cents'))}</td></tr>
      </tbody></table>}
    </section>
    <section className="panel"><h2>Refunds and cancellations</h2>
      {!rows.some(r => r.refund_count) ? <div className="empty">No refunds this month.</div> : <table className="tbl"><thead><tr><th>Sold as</th><th className="n">Refunds</th><th className="n">Refunded sales</th><th className="n">Refunded taxable</th><th className="n">Tax refunded</th><th className="n">Net tax</th></tr></thead><tbody>
        {rows.filter(r => r.refund_count).map(r => <tr key={r.category}><td>{label(r.category)}</td><td className="n">{r.refund_count}</td><td className="n">{money(r.refund_sales_cents)}</td><td className="n">{money(r.refund_taxable_cents)}</td><td className="n">{money(r.refund_tax_cents)}</td><td className="n">{money(net(r).tax)}</td></tr>)}
        <tr className="total"><td>Net after refunds</td><td className="n">{sum('refund_count')}</td><td className="n">{money(sum('sales_cents') - sum('refund_sales_cents'))} net sales</td><td className="n">{money(sum('taxable_cents') - sum('refund_taxable_cents'))} net taxable</td><td className="n">{money(sum('refund_tax_cents'))}</td><td className="n">{money(sum('tax_cents') - sum('refund_tax_cents'))}</td></tr>
      </tbody></table>}
      <p className="hint">Taxable = sales that were charged sales tax. Website orders shipped out of state are charged no California tax. Confirm with your accountant how to report out-of-state and district tax.</p>
    </section>
  </>;
}
