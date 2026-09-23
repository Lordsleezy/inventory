import { useEffect, useMemo, useState } from "react";
import { formatCentsTotal } from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice, Spinner } from "../components/ui";
import { friendlyRpc } from "../rpc";

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

type Bucket = { label: string; sales: number; revenue_cents: number; profit_cents: number };

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

function rollup(days: Report["by_day"], period: "day" | "week" | "month"): Bucket[] {
  const key = (day: string) =>
    period === "day" ? day : period === "week" ? isoWeek(day) : day.slice(0, 7);
  const map = new Map<string, Bucket>();
  for (const d of days) {
    const k = key(d.day);
    const b = map.get(k) ?? { label: k, sales: 0, revenue_cents: 0, profit_cents: 0 };
    b.sales += d.sales;
    b.revenue_cents += d.revenue_cents;
    b.profit_cents += d.profit_cents;
    map.set(k, b);
  }
  return [...map.values()].sort((a, b) => b.label.localeCompare(a.label));
}

export function ReportsScreen() {
  const { session } = useStore();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [period, setPeriod] = useState<"day" | "week" | "month">("day");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  useEffect(() => {
    if (session.role === "staff") return;
    let live = true;
    setReport(null);
    void (async () => {
      try {
        const { data, error: rpcErr } = await floorCloud().rpc("store_report", {
          p_from: fromDate ? `${fromDate}T00:00:00Z` : null,
          p_to: toDate ? `${toDate}T23:59:59.999Z` : null,
        });
        if (!live) return;
        if (rpcErr) setError(friendlyRpc(rpcErr));
        else {
          setError("");
          setReport(data as Report);
        }
      } catch (err) {
        if (live) setError(friendlyRpc(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [session.role, fromDate, toDate]);

  const buckets = useMemo(
    () => (report ? rollup(report.by_day, period) : []),
    [report, period],
  );

  if (session.role === "staff") {
    return <p className="text-quiet text-floor-mute">Reports are for store admins.</p>;
  }
  if (error) {
    return (
      <section>
        <h1 className="text-title">Reports</h1>
        <Notice tone="error">{error}</Notice>
      </section>
    );
  }
  if (!report) return <Spinner label="Building report" />;

  const t = report.totals;
  const inv = report.inventory;
  const margin = t.merchandise_cents ? Math.round((t.gross_profit_cents / t.merchandise_cents) * 100) : 0;

  return (
    <section>
      <h1 className="text-title">Reports</h1>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <Label>From</Label>
          <input className="field mt-1" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </label>
        <label className="block">
          <Label>To</Label>
          <input className="field mt-1" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
      </div>
      {!fromDate && !toDate ? (
        <p className="mt-1 text-quiet text-floor-mute">All time. Pick dates to scope the numbers.</p>
      ) : null}

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5">
        <Stat label="Revenue" value={formatCentsTotal(t.merchandise_cents)} hint={`${t.sales} sales · ${t.units_sold} units`} />
        <Stat label="Gross profit" value={formatCentsTotal(t.gross_profit_cents)} hint={`${margin}% margin`} />
        <Stat label="Sales tax collected" value={formatCentsTotal(t.tax_cents)} />
        <Stat label="Card fees collected" value={formatCentsTotal(t.card_fee_cents)} />
        <Stat label="Total collected" value={formatCentsTotal(t.collected_cents)} hint="merch + tax + fees" />
        <Stat
          label="Discounts given"
          value={formatCentsTotal(t.markdown_cents + t.ticket_discount_cents + t.signup_discount_cents)}
          hint="markdowns + ticket discounts"
        />
      </div>
      {t.uncosted_sales > 0 ? (
        <p className="mt-2 text-quiet text-floor-mute">
          {t.uncosted_sales} {t.uncosted_sales === 1 ? "sale has" : "sales have"} no acquisition cost — profit is
          overstated for those.
        </p>
      ) : null}
      {t.voided_sales > 0 ? (
        <p className="mt-1 text-quiet text-floor-mute">
          {t.voided_sales} voided {t.voided_sales === 1 ? "sale" : "sales"} ({formatCentsTotal(t.voided_cents)})
          excluded above.
        </p>
      ) : null}

      <h2 className="mt-8 text-title">Sales over time</h2>
      <div className="mt-2 flex gap-3">
        {(["day", "week", "month"] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`min-h-touch text-quiet ${period === p ? "text-floor-accent" : "text-floor-mute"}`}
            onClick={() => setPeriod(p)}
          >
            {p === "day" ? "By day" : p === "week" ? "By week" : "By month"}
          </button>
        ))}
      </div>
      {buckets.length === 0 ? (
        <p className="py-4 text-quiet text-floor-mute">No sales in this window.</p>
      ) : (
        <ul className="mt-2">
          {buckets.slice(0, 31).map((b) => (
            <li key={b.label} className="flex items-baseline justify-between gap-3 border-b border-floor-line py-2">
              <span className="text-body">{b.label}</span>
              <span className="shrink-0 text-right">
                <span className="block">{formatCentsTotal(b.revenue_cents)}</span>
                <span className="text-quiet text-floor-mute">
                  {b.sales} · profit {formatCentsTotal(b.profit_cents)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-title">Sales by channel</h2>
      {report.by_channel.length === 0 ? (
        <p className="py-4 text-quiet text-floor-mute">No sales yet.</p>
      ) : (
        <ul className="mt-2">
          {report.by_channel.map((c) => (
            <li key={c.channel} className="flex items-baseline justify-between gap-3 border-b border-floor-line py-2">
              <span className="text-body">{c.channel}</span>
              <span className="shrink-0 text-right">
                <span className="block">{formatCentsTotal(c.revenue_cents)}</span>
                <span className="text-quiet text-floor-mute">
                  {c.sales} · profit {formatCentsTotal(c.profit_cents)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {report.by_payment.length ? (
        <>
          <h2 className="mt-8 text-title">Collected by payment method</h2>
          <ul className="mt-2">
            {report.by_payment.map((p) => (
              <li key={p.method} className="flex items-baseline justify-between gap-3 border-b border-floor-line py-2">
                <span className="text-body">{p.method}</span>
                <span className="shrink-0 text-right">
                  <span className="block">{formatCentsTotal(p.collected_cents)}</span>
                  <span className="text-quiet text-floor-mute">{p.sales} sales</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2 className="mt-8 text-title">Inventory</h2>
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5">
        <Stat label="Units in stock" value={String(inv.units_in_stock)} />
        <Stat label="Value at cost" value={formatCentsTotal(inv.cost_cents)} hint="what you paid" />
        <Stat label="Asking value" value={formatCentsTotal(inv.ask_cents)} hint="if everything sells at ask" />
        <Stat label="Unpriced units" value={String(inv.unpriced)} />
        <Stat label="Missing photos" value={String(inv.missing_photos)} />
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <p className="text-title">{value}</p>
      {hint ? <p className="text-quiet text-floor-mute">{hint}</p> : null}
    </div>
  );
}
