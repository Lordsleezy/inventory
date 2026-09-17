import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formatCents, formatCentsTotal, receiptHtml, type Receipt } from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice, Spinner } from "../components/ui";
import { openHtml } from "../files";

type SaleReceiptRow = {
  id: number;
  sku: string;
  receipt_no: string;
  sold_at: string;
  price_cents: number;
  tax_cents: number;
  total_cents: number;
  payment_method: string | null;
  channel: string;
  voided_at: string | null;
  actor_name: string | null;
  title: string | null;
  condition: string | null;
};

function toReceipt(row: SaleReceiptRow, storeName: string): Receipt {
  return {
    receiptNo: row.receipt_no,
    soldAt: row.sold_at,
    storeName,
    channel: row.channel || "floor",
    paymentMethod: row.payment_method,
    actor: row.actor_name,
    customerName: null,
    customerPhone: null,
    sku: row.sku,
    description: row.title || "Item",
    condition: row.condition,
    priceCents: Number(row.price_cents ?? 0),
    taxCents: Number(row.tax_cents ?? 0),
    totalCents: Number(row.total_cents ?? Number(row.price_cents ?? 0) + Number(row.tax_cents ?? 0)),
    voidedAt: row.voided_at,
  };
}

export function ReportsScreen() {
  const { receiptNo } = useParams();
  const { session, settings } = useStore();
  const manager = session.role !== "staff";
  const [rows, setRows] = useState<SaleReceiptRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [error, setError] = useState("");
  const [totals, setTotals] = useState<{ inStock: number; soldThisWeek: number; moneyTiedUpCents: number; askValueCents: number; soldThisWeekCents: number } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const receipts = await floorCloud()
        .from("sale_receipts")
        .select("id, sku, receipt_no, sold_at, price_cents, tax_cents, total_cents, payment_method, channel, voided_at, actor_name, title, condition")
        .order("sold_at", { ascending: false });
      if (!receipts.error) {
        if (live) setRows((receipts.data ?? []) as SaleReceiptRow[]);
        return;
      }
      const sales = await floorCloud()
        .from("sales")
        .select("id, sku, receipt_no, sold_at, price_cents, tax_cents, payment_method, channel, voided_at")
        .order("sold_at", { ascending: false });
      if (sales.error) throw sales.error;
      if (live) {
        setRows(
          (sales.data ?? []).map((s) => ({
            id: s.id,
            sku: s.sku,
            receipt_no: s.receipt_no,
            sold_at: s.sold_at,
            price_cents: s.price_cents,
            tax_cents: s.tax_cents ?? 0,
            total_cents: (s.price_cents ?? 0) + (s.tax_cents ?? 0),
            payment_method: s.payment_method,
            channel: s.channel,
            voided_at: s.voided_at,
            actor_name: null,
            title: null,
            condition: null,
          })),
        );
      }
    })().catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!manager) return;
    let live = true;
    void (async () => {
      const units = await floorCloud().from("units").select("state, acquisition_cost_cents, ask_cents");
      const sales = await floorCloud().from("sales").select("price_cents, sold_at, voided_at").is("voided_at", null);
      if (units.error) throw units.error;
      if (sales.error) throw sales.error;
      const week = Date.now() - 7 * 24 * 3600 * 1000;
      const stock = (units.data ?? []).filter((u) => ["available", "reserved", "repair"].includes(u.state));
      const weekSales = (sales.data ?? []).filter((s) => new Date(s.sold_at).getTime() >= week);
      if (live) {
        setTotals({
          inStock: stock.length,
          soldThisWeek: weekSales.length,
          moneyTiedUpCents: stock.reduce((n, u) => n + (u.acquisition_cost_cents ?? 0), 0),
          askValueCents: stock.reduce((n, u) => n + (u.ask_cents ?? 0), 0),
          soldThisWeekCents: weekSales.reduce((n, s) => n + (s.price_cents ?? 0), 0),
        });
      }
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [manager]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((row) => {
      if (q && !row.receipt_no.toLowerCase().includes(q) && !row.sku.toLowerCase().includes(q)) return false;
      const t = new Date(row.sold_at).getTime();
      if (fromDate) {
        const start = new Date(`${fromDate}T00:00:00`).getTime();
        if (t < start) return false;
      }
      if (toDate) {
        const end = new Date(`${toDate}T23:59:59.999`).getTime();
        if (t > end) return false;
      }
      return true;
    });
  }, [rows, query, fromDate, toDate]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!rows) return <Spinner label="Loading receipts" />;

  if (receiptNo) {
    const row = rows.find((r) => r.receipt_no === decodeURIComponent(receiptNo));
    if (!row) {
      return (
        <section>
          <p className="text-body">No receipt {decodeURIComponent(receiptNo)}.</p>
          <Link to="/reports" className="btn-text px-0">Back to receipts</Link>
        </section>
      );
    }
    return <ReceiptDetail receipt={toReceipt(row, settings.storeName)} />;
  }

  return (
    <section>
      <h1 className="text-title">Reports</h1>

      {manager && totals ? (
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5">
          <Stat label="Units in stock" value={String(totals.inStock)} />
          <Stat label="Sold this week" value={String(totals.soldThisWeek)} />
          <Stat label="Money tied up" value={formatCentsTotal(totals.moneyTiedUpCents)} hint="what you paid" />
          <Stat label="Asking value" value={formatCentsTotal(totals.askValueCents)} hint="priced units only" />
          <Stat label="Took this week" value={formatCentsTotal(totals.soldThisWeekCents)} />
        </div>
      ) : null}

      <h2 className="mt-8 text-title">Receipts</h2>
      <input
        className="field mt-3"
        value={query}
        placeholder="Receipt number or SKU"
        inputMode="search"
        autoCapitalize="none"
        onChange={(e) => setQuery(e.target.value)}
      />
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

      {filtered.length === 0 ? (
        <p className="py-6 text-quiet text-floor-mute">No receipts match.</p>
      ) : (
        <ul className="mt-3">
          {filtered.map((row) => (
            <li key={row.id} className="border-b border-floor-line">
              <Link to={`/reports/${encodeURIComponent(row.receipt_no)}`} className="flex min-h-touch items-baseline justify-between gap-3 py-3">
                <span>
                  <span className="font-mono">{row.receipt_no}</span>
                  {row.voided_at ? <span className="ml-2 text-floor-danger">VOID</span> : null}
                  <span className="mt-1 block text-quiet text-floor-mute">
                    {row.sku} · {row.title || "Item"}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block">{formatCents(row.total_cents)}</span>
                  <span className="text-quiet text-floor-mute">{new Date(row.sold_at).toLocaleString("en-US")}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReceiptDetail({ receipt }: { receipt: Receipt }) {
  const navigate = useNavigate();
  const [shareError, setShareError] = useState("");

  async function share() {
    setShareError("");
    try {
      await openHtml(`receipt-${receipt.receiptNo}.html`, receiptHtml(receipt));
    } catch (err) {
      setShareError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <button type="button" className="btn-text px-0" onClick={() => navigate("/reports")}>
        All receipts
      </button>
      {receipt.voidedAt ? <p className="mt-3 border border-floor-danger p-2 text-body text-floor-danger">VOID</p> : null}
      <h1 className="mt-3 font-mono text-title">{receipt.receiptNo}</h1>
      <Notice tone="error">{shareError}</Notice>
      <dl className="mt-4">
        <Row label="Date / time" value={new Date(receipt.soldAt).toLocaleString("en-US")} />
        <Row label="SKU" value={receipt.sku} />
        <Row label="Title" value={receipt.description} />
        <Row label="Condition" value={receipt.condition || "—"} />
        <Row label="Price" value={formatCents(receipt.priceCents) || "$0.00"} />
        <Row label="Tax" value={formatCents(receipt.taxCents) || "$0.00"} />
        <Row label="Total" value={formatCentsTotal(receipt.totalCents)} />
        <Row label="Payment" value={receipt.paymentMethod || "—"} />
        <Row label="Channel" value={receipt.channel} />
        <Row label="Rang up by" value={receipt.actor || "—"} />
      </dl>
      <button type="button" className="btn-accent mt-6" onClick={() => void share()}>
        Share / print
      </button>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-floor-line py-2">
      <dt className="text-quiet text-floor-mute">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
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
