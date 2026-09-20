import { useEffect, useState } from "react";
import { floorCloud, approveWithPin, authErrorMessage, voidTicket } from "@floor/cloud";
import { usePos } from "../pos-context";
import { printReceipt } from "../print-receipt";
import { type ReceiptPayload } from "../receipt";

type ReceiptRow = {
  id: string;
  sku: string;
  receipt_no: string;
  ticket_id: string | null;
  sold_at: string;
  price_cents: number;
  tax_cents: number;
  total_cents: number;
  payment_method: string | null;
  actor_name: string | null;
  title: string | null;
  condition: string | null;
  voided_at: string | null;
};

export function ReceiptsScreen() {
  const { online, settings, incidents, isAdmin, syncOutbox, pendingOutbox } = usePos();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [error, setError] = useState("");
  const [pin, setPin] = useState("");
  const [voidTicketId, setVoidTicketId] = useState<string | null>(null);

  useEffect(() => {
    if (!online) return;
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
    async function load() {
      const sb = floorCloud();
      let query = sb
        .from("sale_receipts")
        .select(
          "id, sku, receipt_no, ticket_id, sold_at, price_cents, tax_cents, total_cents, payment_method, actor_name, title, condition, voided_at",
        )
        .order("sold_at", { ascending: false })
        .limit(80);
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

  async function confirmVoid() {
    if (!voidTicketId) return;
    try {
      let approval: string | null = null;
      if (!isAdmin) {
        approval = await approveWithPin("void_ticket", rows.find((r) => r.ticket_id === voidTicketId)?.sku || "", pin, voidTicketId);
      }
      await voidTicket(voidTicketId, "void last ticket", approval);
      setVoidTicketId(null);
      setPin("");
      setError("");
      // reload
      setQ((q) => q + "");
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  const latestTicket = rows.find((r) => r.ticket_id && !r.voided_at)?.ticket_id ?? null;

  return (
    <section className="page">
      <h1>Receipts</h1>
      {incidents.map((inc) => (
        <div className="incident" key={inc.id}>
          <strong>{inc.sku}</strong>
          <p>{inc.message}</p>
        </div>
      ))}
      {pendingOutbox ? (
        <p className="muted">
          {pendingOutbox} legacy offline cash row(s).{" "}
          <button type="button" disabled={!online} onClick={() => void syncOutbox()}>
            Sync legacy
          </button>
        </p>
      ) : null}
      {latestTicket ? (
        <button type="button" className="danger" onClick={() => setVoidTicketId(latestTicket)}>
          Void latest ticket
        </button>
      ) : null}
      <input className="search" placeholder="Receipt # or SKU" value={q} onChange={(e) => setQ(e.target.value)} />
      {error ? <p className="error">{error}</p> : null}
      <div className="grid" style={{ marginTop: "1rem" }}>
        {rows.map((row) => (
          <div className="card row" key={row.id}>
            <div>
              <strong>
                {row.receipt_no}
                {row.voided_at ? " (voided)" : ""}
              </strong>
              <div>
                SKU {row.sku} · {row.title}
              </div>
              <div className="muted">{new Date(row.sold_at).toLocaleString()}</div>
            </div>
            <button type="button" disabled={Boolean(row.voided_at)} onClick={() => void reprint(row)}>
              Reprint
            </button>
          </div>
        ))}
      </div>

      {voidTicketId ? (
        <div className="modal">
          <div className="card grid">
            <h2>Void ticket</h2>
            <p className="muted">Restores units to available and notifies channels to relist.</p>
            {!isAdmin ? (
              <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="Manager PIN" />
            ) : null}
            <div className="row">
              <button type="button" onClick={() => setVoidTicketId(null)}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={() => void confirmVoid()}>
                Void
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
