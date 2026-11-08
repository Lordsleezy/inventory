import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Period = 'week' | 'month' | 'quarter';
type SalePeriod = { period_start: string; channel: string; sales_cents: number; profit_cents: number; units_sold: number };
type Category = { category: string; received_units: number; stock_units: number; sold_units: number; revenue_cents: number; profit_cents: number; avg_days_to_sell: number | null };
type Census = { year: number; quarter: number; not_adjusted_millions: number; fetched_at: string };
type Manifest = { id: string; name: string; item_count: number; revenue_cents: number; profit_cents: number };
type Insights = { first_sale_on: string | null; periods: SalePeriod[]; categories: Category[]; aging: { days_30: number; days_60: number; days_90_plus: number } };
type Props = { client: SupabaseClient; money: (cents: number) => string };
const CHANNELS = ['all', 'in-store', 'online', 'ebay', 'amazon', 'tiktok', 'depop', 'website'];

function seasonality(rows: Census[]) {
  const years = new Map<number, Record<number, number>>();
  for (const row of rows) years.set(row.year, { ...years.get(row.year), [row.quarter]: Number(row.not_adjusted_millions) });
  const full = [...years.entries()].filter(([, q]) => [1, 2, 3, 4].every((n) => q[n] > 0))
    .sort((a, b) => b[0] - a[0]).slice(0, 5);
  if (!full.length) return [1, 1, 1, 1];
  return [1, 2, 3, 4].map((q) => full.reduce((sum, [, year]) =>
    sum + year[q] / ((year[1] + year[2] + year[3] + year[4]) / 4), 0) / full.length);
}

function ForecastChart({ values, money }: { values: { label: string; midpoint: number; low: number; high: number }[]; money: Props['money'] }) {
  const max = Math.max(1, ...values.map((value) => value.high));
  const x = (i: number) => 48 + i * (288 / Math.max(1, values.length - 1));
  const y = (n: number) => 148 - n / max * 116;
  const band = values.map((value, i) => `${x(i)},${y(value.high)}`).join(' ') + ' ' +
    values.map((_, i) => `${x(values.length - i - 1)},${y(values[values.length - i - 1].low)}`).join(' ');
  return <div className="insights-chart-scroll"><svg viewBox="0 0 380 185" role="img" aria-label="Forecast with low and high confidence band">
    <line x1="48" y1="148" x2="342" y2="148" stroke="currentColor" opacity=".35" />
    <polygon points={band} fill="#0a84ff" opacity=".18" />
    <polyline points={values.map((value, i) => `${x(i)},${y(value.midpoint)}`).join(' ')} fill="none" stroke="#0a84ff" strokeWidth="3" />
    {values.map((value, i) => <g key={value.label}>
      <circle cx={x(i)} cy={y(value.midpoint)} r="4" fill="#0a84ff" />
      <text x={x(i)} y="168" textAnchor="middle" fill="currentColor" fontSize="11">{value.label}</text>
      <title>{value.label}: {money(value.midpoint)} · range {money(value.low)}–{money(value.high)}</title>
    </g>)}
    <text x="42" y="36" textAnchor="end" fill="currentColor" fontSize="10">{money(max)}</text>
    <text x="42" y="150" textAnchor="end" fill="currentColor" fontSize="10">$0</text>
  </svg></div>;
}

export function InsightsPage({ client, money }: Props) {
  const [period, setPeriod] = useState<Period>('month');
  const [channel, setChannel] = useState('all');
  const [data, setData] = useState<Insights | null>(null);
  const [census, setCensus] = useState<Census[]>([]);
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [insights, censusResult, manifestResult] = await Promise.all([
      client.rpc('portal_insights', { p_period: period }),
      client.from('census_ecommerce_quarters').select('year,quarter,not_adjusted_millions,fetched_at')
        .order('year', { ascending: false }).order('quarter', { ascending: false }).limit(24),
      client.rpc('portal_manifest_list'),
    ]);
    if (insights.error) throw insights.error;
    if (censusResult.error) throw censusResult.error;
    if (manifestResult.error) throw manifestResult.error;
    setData(insights.data as Insights);
    setCensus((censusResult.data || []) as Census[]);
    setManifests((manifestResult.data || []) as Manifest[]);
  }, [client, period]);
  useEffect(() => { void load().catch((e) => setError(String(e.message || e))); }, [load]);

  const series = useMemo(() => {
    const byDate = new Map<string, { label: string; sales: number; profit: number }>();
    for (const row of data?.periods || []) {
      const isStore = ['floor', 'store', 'pos'].includes(row.channel);
      if (channel !== 'all' && !(channel === 'in-store' && isStore)
        && !(channel === 'online' && !isStore) && channel !== row.channel) continue;
      const current = byDate.get(row.period_start) || { label: row.period_start, sales: 0, profit: 0 };
      current.sales += Number(row.sales_cents); current.profit += Number(row.profit_cents);
      byDate.set(row.period_start, current);
    }
    return [...byDate.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(-16);
  }, [data, channel]);
  const maxSales = Math.max(1, ...series.map((row) => row.sales));
  const sorted = [...(data?.categories || [])].sort((a, b) => b.sold_units - a.sold_units);
  const first = data?.first_sale_on ? new Date(data.first_sale_on + 'T00:00:00').getTime() : Date.now();
  const historyDays = Math.max(0, (Date.now() - first) / 86400000);
  const factors = seasonality(census);
  const now = new Date();
  const quarterNow = Math.floor(now.getMonth() / 3);
  const quarterSales = (data?.periods || []).filter((row) => {
    const d = new Date(row.period_start + 'T00:00:00');
    return d.getFullYear() === now.getFullYear() && Math.floor(d.getMonth() / 3) === quarterNow;
  }).reduce((n, row) => n + Number(row.sales_cents), 0);
  const quarterStart = new Date(now.getFullYear(), quarterNow * 3, 1);
  const elapsed = Math.max(1, (Date.now() - quarterStart.getTime()) / 86400000);
  const daily = quarterSales > 0 ? quarterSales / elapsed : series.reduce((n, row) => n + row.sales, 0) / Math.max(1, historyDays);
  const width = Math.max(.25, Math.min(.8, 1.1 / Math.sqrt(Math.max(1, historyDays / 30))));
  const forecast = [1, 2, 3, 4].map((step) => {
    const q = (quarterNow + step) % 4;
    const year = now.getFullYear() + Math.floor((quarterNow + step) / 4);
    const seasonal = factors[q] / (factors[quarterNow] || 1);
    const midpoint = Math.max(0, Math.round(daily * 91 * seasonal));
    const band = Math.min(.9, width + (step - 1) * .08);
    return { label: `Q${q + 1} ’${String(year).slice(-2)}`, midpoint,
      low: Math.round(midpoint * (1 - band)), high: Math.round(midpoint * (1 + band)) };
  });

  return <div className="insights-page">
    <header><div><div className="eyebrow">YOUR STORE DATA</div><h1>Insights</h1>
      <p>Sales, categories, inventory aging and manifest returns.</p></div></header>
    {error && <div className="alert" role="alert">{error}</div>}
    <section className="panel"><div className="section-head"><h2>Sales and profit over time</h2>
      <div className="actions"><select aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
        <option value="week">Week</option><option value="month">Month</option><option value="quarter">Quarter</option>
      </select><select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
        {CHANNELS.map((value) => <option key={value} value={value}>{value === 'all' ? 'All channels' : value}</option>)}
      </select></div></div>
      {!data ? <p>Loading…</p> : series.length === 0 ? <p className="empty">No sales in this view.</p>
        : <div className="insights-bars">{series.map((row) => <div className="insights-bar" key={row.label}>
          <span>{row.label}</span><div className="insights-bar-track"><i style={{ width: `${Math.max(2, row.sales / maxSales * 100)}%` }} /></div>
          <strong>{money(row.sales)}</strong><small>Profit {money(row.profit)}</small>
        </div>)}</div>}
    </section>
    <section className="panel"><h2>Category performance</h2>
      <div className="insights-category-list">{sorted.map((row) => {
        const denominator = row.sold_units + row.stock_units;
        const sellThrough = denominator ? Math.round(row.sold_units / denominator * 100) : 0;
        const margin = row.revenue_cents ? Math.round(row.profit_cents / row.revenue_cents * 100) : 0;
        return <details key={row.category}><summary><strong>{row.category}</strong><span>{row.sold_units} sold · {sellThrough}% sell-through</span></summary>
          <div className="insights-category-detail"><span>Profit {money(row.profit_cents)}</span><span>Margin {margin}%</span>
            <span>Average {row.avg_days_to_sell ?? '—'} days to sell</span><span>{row.stock_units} in stock</span></div></details>;
      })}</div>
      {sorted.length > 1 && <p className="hint">Best seller: {sorted[0].category} · Slowest: {sorted[sorted.length - 1].category}</p>}
    </section>
    <section className="panel"><h2>Aging inventory</h2><div className="insights-aging">
      <div><strong>{data?.aging.days_30 || 0}</strong><span>30–59 days</span></div>
      <div><strong>{data?.aging.days_60 || 0}</strong><span>60–89 days</span></div>
      <div><strong>{data?.aging.days_90_plus || 0}</strong><span>90+ days</span></div>
    </div></section>
    <section className="panel"><h2>Manifest ROI</h2>
      {manifests.length === 0 ? <p className="empty">Tag units to manifests to see their returns.</p>
        : <div className="insights-category-list">{manifests.map((row) => <div className="insights-manifest" key={row.id}>
          <strong>{row.name}</strong><span>{row.item_count} manifested · Revenue {money(row.revenue_cents)} · Profit {money(row.profit_cents)}</span>
        </div>)}</div>}
    </section>
    <section className="panel"><h2>Next four quarters</h2>
      <p className="hint">{historyDays < 90 ? 'Low confidence · less than one quarter of store history.' : 'Trend projection from store sales.'}
        {' '}Seasonality uses cached U.S. Census quarterly e-commerce sales{census.length ? `; last refreshed ${census[0].fetched_at.slice(0, 10)}.` : ' when available.'}</p>
      {daily > 0 ? <><ForecastChart values={forecast} money={money} />
        <div className="insights-forecast-list">{forecast.map((point) => <div key={point.label}><strong>{point.label}</strong>
          <span>{money(point.midpoint)} · range {money(point.low)}–{money(point.high)}</span></div>)}</div></>
        : <p className="empty">More sales history is needed to show a projection.</p>}
    </section>
  </div>;
}
