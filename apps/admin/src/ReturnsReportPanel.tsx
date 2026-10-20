import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

type Props = {
  client: SupabaseClient;
  money: (n: number) => string;
};

type Report = {
  by_channel: { channel: string; returns: number; sales: number; return_rate: number; total_cost_cents: number; refund_cents: number; label_cents: number; fee_cents: number; regrade_loss_cents: number }[];
  by_category: { category: string; returns: number; total_cost_cents: number }[];
  by_month: { month: string; returns: number; total_cost_cents: number }[];
};

function rangeLastYear() {
  const to = new Date();
  const from = new Date(to.getTime() - 365 * 86400_000);
  return { p_from: from.toISOString(), p_to: to.toISOString() };
}

export function ReturnsReportPanel({ client, money }: Props) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data, error: e } = await client.rpc('portal_return_report', rangeLastYear());
    if (e) {
      setError(e.message);
      return;
    }
    setReport(data as Report);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <section className="panel">
        <div className="alert" role="alert">
          {error}
        </div>
      </section>
    );
  }
  if (!report) return <section className="panel"><p className="hint">Loading return report…</p></section>;

  return (
    <section className="panel">
      <div className="section-head">
        <div>
          <div className="eyebrow">RETURNS</div>
          <h2>Return rate &amp; cost (last 12 months)</h2>
        </div>
        <button type="button" className="secondary" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      <h3>By channel</h3>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Channel</th>
              <th className="n">Returns</th>
              <th className="n">Sales</th>
              <th className="n">Rate %</th>
              <th className="n">Refund</th>
              <th className="n">Labels</th>
              <th className="n">Fees</th>
              <th className="n">Re-grade</th>
              <th className="n">Total cost</th>
            </tr>
          </thead>
          <tbody>
            {(report.by_channel || []).map((r) => (
              <tr key={r.channel}>
                <td>{r.channel}</td>
                <td className="n">{r.returns}</td>
                <td className="n">{r.sales}</td>
                <td className="n">{r.return_rate}</td>
                <td className="n">{money(r.refund_cents)}</td>
                <td className="n">{money(r.label_cents)}</td>
                <td className="n">{money(r.fee_cents)}</td>
                <td className="n">{money(r.regrade_loss_cents)}</td>
                <td className="n">{money(r.total_cost_cents)}</td>
              </tr>
            ))}
            {!report.by_channel?.length && (
              <tr>
                <td colSpan={9}>No returns in range.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3>By category</h3>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Category</th>
              <th className="n">Returns</th>
              <th className="n">Total cost</th>
            </tr>
          </thead>
          <tbody>
            {(report.by_category || []).map((r) => (
              <tr key={r.category}>
                <td>{r.category}</td>
                <td className="n">{r.returns}</td>
                <td className="n">{money(r.total_cost_cents)}</td>
              </tr>
            ))}
            {!report.by_category?.length && (
              <tr>
                <td colSpan={3}>No returns in range.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3>By month</h3>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Month</th>
              <th className="n">Returns</th>
              <th className="n">Total cost</th>
            </tr>
          </thead>
          <tbody>
            {(report.by_month || []).map((r) => (
              <tr key={r.month}>
                <td>{r.month}</td>
                <td className="n">{r.returns}</td>
                <td className="n">{money(r.total_cost_cents)}</td>
              </tr>
            ))}
            {!report.by_month?.length && (
              <tr>
                <td colSpan={3}>No returns in range.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
