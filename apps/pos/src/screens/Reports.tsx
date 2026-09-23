import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { floorCloud } from "@floor/cloud";
import { formatCents } from "@floor/store";
import { usePos } from "../pos-context";

type Report = {
  totals: {
    sales: number;
    units_sold: number;
    merchandise_cents: number;
    tax_cents: number;
    card_fee_cents: number;
    collected_cents: number;
    markdown_cents: number;
    gross_profit_cents: number;
    uncosted_sales: number;
    voided_sales: number;
    voided_cents: number;
    ticket_discount_cents: number;
    signup_discount_cents: number;
  };
  by_day: { day: string; sales: number; revenue_cents: number; tax_cents: number; profit_cents: number }[];
  by_channel: { channel: string; sales: number; revenue_cents: number; profit_cents: number }[];
  by_payment: { method: string; sales: number; collected_cents: number }[];
  inventory: {
    units_in_stock: number;
    cost_cents: number;
    ask_cents: number;
    unpriced: number;
    missing_photos: number;
  };
};

function money(cents: number): string {
  return formatCents(cents) || "$0.00";
}

function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fdow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdow + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400_000));
  return `${d.getUTCFullYear()} W${String(week).padStart(2, "0")}`;
}

export function ReportsScreen() {
  const { isAdmin } = usePos();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState<"day" | "week" | "month">("day");

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    void (async () => {
      try {
        const { data, error: rpcErr } = await floorCloud().rpc("store_report", { p_from: null, p_to: null });
        if (!live) return;
        if (rpcErr) setError(rpcErr.message);
        else setReport(data as Report);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [isAdmin]);

  const buckets = useMemo(() => {
    if (!report) return [];
    const key = (day: string) =>
      period === "day" ? day : period === "week" ? isoWeek(day) : day.slice(0, 7);
    const map = new Map<string, { label: string; sales: number; revenue: number; profit: number }>();
    for (const d of report.by_day) {
      const k = key(d.day);
      const b = map.get(k) ?? { label: k, sales: 0, revenue: 0, profit: 0 };
      b.sales += d.sales;
      b.revenue += d.revenue_cents;
      b.profit += d.profit_cents;
      map.set(k, b);
    }
    return [...map.values()].sort((a, b) => b.label.localeCompare(a.label));
  }, [report, period]);

  if (!isAdmin) return <p className="page muted">Reports are for store admins.</p>;
  if (error) return <p className="page error">{error}</p>;
  if (!report) return <p className="page muted">Building report…</p>;

  const t = report.totals;
  const inv = report.inventory;
  const margin = t.merchandise_cents ? Math.round((t.gross_profit_cents / t.merchandise_cents) * 100) : 0;

  return (
    <section className="page grid">
      <div className="row">
        <h1>Reports</h1>
        <Link to="/receipts">Receipts →</Link>
      </div>

      <div className="card grid">
        <strong>All time</strong>
        <div className="row">Revenue <span className="price">{money(t.merchandise_cents)}</span></div>
        <div className="row muted">{t.sales} sales · {t.units_sold} units</div>
        <div className="row">Gross profit <span className="price">{money(t.gross_profit_cents)}</span></div>
        <div className="row muted">{margin}% margin</div>
        <div className="row">Sales tax collected <span className="price">{money(t.tax_cents)}</span></div>
        <div className="row">Card fees collected <span className="price">{money(t.card_fee_cents)}</span></div>
        <div className="row">Total collected <span className="price">{money(t.collected_cents)}</span></div>
        <div className="row muted">
          Discounts {money(t.markdown_cents + t.ticket_discount_cents + t.signup_discount_cents)}
          {t.voided_sales ? ` · ${t.voided_sales} voided (${money(t.voided_cents)})` : ""}
          {t.uncosted_sales ? ` · ${t.uncosted_sales} sale(s) missing cost` : ""}
        </div>
      </div>

      <div className="card grid">
        <strong>Sales over time</strong>
        <div className="row">
          {(["day", "week", "month"] as const).map((p) => (
            <button key={p} type="button" className={period === p ? "primary" : ""} onClick={() => setPeriod(p)}>
              {p}
            </button>
          ))}
        </div>
        {buckets.slice(0, 14).map((b) => (
          <div key={b.label} className="row">
            <span>{b.label} · {b.sales}</span>
            <span>{money(b.revenue)} <span className="muted">(profit {money(b.profit)})</span></span>
          </div>
        ))}
        {!buckets.length ? <p className="muted">No sales yet.</p> : null}
      </div>

      <div className="card grid">
        <strong>By channel</strong>
        {report.by_channel.map((c) => (
          <div key={c.channel} className="row">
            <span>{c.channel} · {c.sales}</span>
            <span>{money(c.revenue_cents)} <span className="muted">(profit {money(c.profit_cents)})</span></span>
          </div>
        ))}
      </div>

      {report.by_payment.length ? (
        <div className="card grid">
          <strong>By payment method</strong>
          {report.by_payment.map((p) => (
            <div key={p.method} className="row">
              <span>{p.method} · {p.sales}</span>
              <span>{money(p.collected_cents)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="card grid">
        <strong>Inventory</strong>
        <div className="row">Units in stock <span className="price">{inv.units_in_stock}</span></div>
        <div className="row">Value at cost <span className="price">{money(inv.cost_cents)}</span></div>
        <div className="row">Asking value <span className="price">{money(inv.ask_cents)}</span></div>
        <div className="row muted">{inv.unpriced} unpriced · {inv.missing_photos} missing photos</div>
      </div>
    </section>
  );
}
