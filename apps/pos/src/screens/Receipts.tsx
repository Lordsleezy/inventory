import { useEffect, useState } from "react";
import { floorCloud } from "@floor/cloud";
import { usePos } from "../pos-context";
import { printReceipt } from "../print-receipt";
import { type ReceiptPayload } from "../receipt";

type ReceiptRow = {
  id: string;
  sku: string;
  receipt_no: string;
  sold_at: string;
  price_cents: number;
  tax_cents: number;
  total_cents: number;
  payment_method: string | null;
  actor_name: string | null;
  title: string | null;
  condition: string | null;
};

export function ReceiptsScreen() {
  const { online, settings, incidents, pendingOutbox, syncOutbox } = usePos();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!online) return;
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
    async function load() {
      const sb = floorCloud();
      let query = sb
        .from("sale_receipts")
        .select(
          "id, sku, receipt_no, sold_at, price_cents, tax_cents, total_cents, payment_method, actor_name, title, condition",
        )
        .order("sold_at", { ascending: false })
        .limit(50);
      const text = q.trim();
      if (text) {
        query = query.or(`receipt_no.ilike.%${text}%,sku.eq.${text}`);
      }
      const { data, error: err } = await query;
      if (err) setError(err.message);
      else setRows((data ?? []) as ReceiptRow[]);
    }
  }, [q, online]);

  async function reprint(row: ReceiptRow) {
    const payload: ReceiptPayload = {
      receiptNo: row.receipt_no,
      soldAt: new Date(row.sold_at).toLocaleString(),
      clerkName: row.actor_name || "",
      sku: row.sku,
      title: row.title || "Item",
      condition: row.condition,
      priceCents: row.price_cents,
      taxCents: row.tax_cents,
      totalCents: row.total_cents,
      tender: (row.payment_method || "").toUpperCase(),
      reviewUrl: settings.reviewUrl || null,
    };
    await printReceipt(payload, settings);
  }

  return (
    <section className="page">
      <h1>Receipts</h1>
      {incidents.map((inc) => (
        <div className="incident" key={inc.id}>
          <strong>{inc.sku}</strong>
          <p>{inc.message}</p>
        </div>
      ))}
      <p className="muted">{pendingOutbox} cash sale(s) waiting to sync.</p>
      <button type="button" disabled={!online} onClick={() => void syncOutbox()}>
        Sync now
      </button>
      <input className="search" placeholder="Receipt # or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
      {error ? <p className="error">{error}</p> : null}
      <div className="grid" style={{ marginTop: "1rem" }}>
        {rows.map((row) => (
          <div className="card row" key={row.id}>
            <div>
              <strong>{row.receipt_no}</strong>
              <div>
                SKU {row.sku} · {row.title}
              </div>
              <div className="muted">{new Date(row.sold_at).toLocaleString()}</div>
            </div>
            <button type="button" onClick={() => void reprint(row)}>
              Reprint
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
