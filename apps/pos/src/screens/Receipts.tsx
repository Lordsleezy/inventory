import { useEffect, useState } from "react";
import { floorCloud, approveWithPin, authErrorMessage, voidTicket } from "@floor/cloud";
import { usePos } from "../pos-context";
import { printReceipt, saveReceiptFile } from "../print-receipt";
import { type ReceiptPayload } from "../receipt";
import { callFunction } from "../functions";

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
  card_brand: string | null;
  card_last4: string | null;
  actor_name: string | null;
  title: string | null;
  condition: string | null;
  voided_at: string | null;
  list_price_cents?: number | null;
};

function rowPayload(row: ReceiptRow, settings: { reviewUrl: string }): ReceiptPayload {
  return {
    receiptNo: row.receipt_no,
    soldAt: new Date(row.sold_at).toLocaleString(),
    clerkName: row.actor_name || "",
    sku: row.sku,
    title: row.title || "Item",
    condition: row.condition,
    priceCents: row.price_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    tender:
      (row.payment_method || "").toUpperCase() +
      (row.card_brand || row.card_last4
        ? ` · ${[row.card_brand, row.card_last4 ? `•••• ${row.card_last4}` : null].filter(Boolean).join(" ")}`
        : ""),
    tenderDetails: {
      method: (row.payment_method || "cash").toUpperCase(),
      cardBrand: row.card_brand,
      cardLast4: row.card_last4,
    },
    discountCents:
      row.list_price_cents != null && row.list_price_cents > row.price_cents
        ? row.list_price_cents - row.price_cents
        : null,
    reviewUrl: settings.reviewUrl || null,
    lines: [
      {
        sku: row.sku,
        title: row.title || "Item",
        condition: row.condition,
        priceCents: row.price_cents,
        taxCents: row.tax_cents,
        listPriceCents: row.list_price_cents ?? null,
      },
    ],
  };
}

export function ReceiptsScreen() {
  const { online, settings, incidents, isAdmin, syncOutbox, pendingOutbox } = usePos();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [pin, setPin] = useState("");
  const [voidTicketId, setVoidTicketId] = useState<string | null>(null);
  const [saveFor, setSaveFor] = useState<string | null>(null);
  const [emailFor, setEmailFor] = useState<string | null>(null);
  const [email, setEmail] = useState("");

  useEffect(() => {
    if (!online) return;
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
    async function load() {
      const sb = floorCloud();
      let query = sb
        .from("sale_receipts")
        .select(
          "id, sku, receipt_no, ticket_id, sold_at, price_cents, tax_cents, total_cents, payment_method, card_brand, card_last4, actor_name, title, condition, voided_at, list_price_cents",
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
    setError("");
    setMsg("");
    setSaveFor(null);
    const payload = rowPayload(row, settings);
    const result = await printReceipt(payload, settings);
    if (result.printed) {
      setMsg(result.detail || "Sent to printer.");
      return;
    }
    setError(result.detail || "Print failed.");
    if (result.code === "no_printer") setSaveFor(row.id);
  }

  async function saveFile(row: ReceiptRow) {
    try {
      const saved = await saveReceiptFile(rowPayload(row, settings), settings);
      setMsg(`Saved receipt to ${saved.path}`);
      setSaveFor(null);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function sendEmail(row: ReceiptRow) {
    const to = email.trim();
    if (!to || !row.ticket_id) {
      setError("Email needs a ticket and address.");
      return;
    }
    try {
      const res = await callFunction("email-receipt", {
        method: "POST",
        body: JSON.stringify({ ticketId: row.ticket_id, toEmail: to }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Email failed (${res.status})`);
      setMsg(`Receipt emailed to ${to}`);
      setEmailFor(null);
      setEmail("");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
      {msg ? <p>{msg}</p> : null}
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
              {saveFor === row.id ? (
                <button type="button" onClick={() => void saveFile(row)}>
                  Save as PDF/file
                </button>
              ) : null}
              {emailFor === row.id ? (
                <div className="row" style={{ marginTop: "0.5rem" }}>
                  <input
                    type="email"
                    placeholder="Customer email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <button type="button" onClick={() => void sendEmail(row)}>
                    Send
                  </button>
                  <button type="button" onClick={() => setEmailFor(null)}>
                    Cancel
                  </button>
                </div>
              ) : null}
            </div>
            <div className="grid">
              <button type="button" disabled={Boolean(row.voided_at)} onClick={() => void reprint(row)}>
                Reprint
              </button>
              <button
                type="button"
                disabled={Boolean(row.voided_at) || !row.ticket_id}
                onClick={() => {
                  setEmailFor(row.id);
                  setEmail("");
                }}
              >
                Email
              </button>
            </div>
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
