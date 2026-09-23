import { useEffect, useState } from "react";
import { floorCloud, approveWithPin, authErrorMessage, voidTicket } from "@floor/cloud";
import { usePos } from "../pos-context";
import { loadReceiptBranding, printReceipt, saveReceiptFile } from "../print-receipt";
import { type ReceiptBranding, type ReceiptPayload } from "../receipt";
import { manualRefundMessage } from "../manual-card";
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
  payment_id?: string | null;
  card_fee_cents?: number;
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
  const [branding, setBranding] = useState<ReceiptBranding | null>(null);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, { msg?: string; error?: string }>>({});

  useEffect(() => {
    if (!online) return;
    void loadReceiptBranding()
      .then(setBranding)
      .catch(() => setBranding(null));
  }, [online]);

  function setRowResult(id: string, result: { msg?: string; error?: string }) {
    setRowStatus((prev) => ({ ...prev, [id]: result }));
  }

  useEffect(() => {
    if (!online) return;
    const t = setTimeout(() => void load(), 150);
    return () => clearTimeout(t);
    async function load() {
      const sb = floorCloud();
      const text = q.trim();
      const buildQuery = (cols: string) => {
        let query = sb
          .from("sale_receipts")
          .select(cols)
          .order("sold_at", { ascending: false })
          .limit(80);
        if (text) query = query.or(`receipt_no.ilike.%${text}%,sku.eq.${text}`);
        return query;
      };
      // card_fee_cents only exists after the card-fee migration lands; retry
      // without it so the screen still works against an older schema.
      let { data, error: err } = await buildQuery(
        "id, sku, receipt_no, ticket_id, sold_at, price_cents, tax_cents, card_fee_cents, total_cents, payment_method, payment_id, card_brand, card_last4, actor_name, title, condition, voided_at, list_price_cents",
      );
      if (err && /card_fee_cents/i.test(err.message)) {
        ({ data, error: err } = await buildQuery(
          "id, sku, receipt_no, ticket_id, sold_at, price_cents, tax_cents, total_cents, payment_method, payment_id, card_brand, card_last4, actor_name, title, condition, voided_at, list_price_cents",
        ));
      }
      if (err) setError(err.message);
      else setRows((data ?? []) as unknown as ReceiptRow[]);
    }
  }, [q, online]);

  async function reprint(row: ReceiptRow) {
    setError("");
    setMsg("");
    setSaveFor(null);
    setPrintingId(row.id);
    setRowResult(row.id, { msg: "Printing…" });
    try {
      const payload = rowPayload(row, settings);
      const result = await printReceipt(payload, settings, branding);
      if (result.printed) {
        setRowResult(row.id, { msg: result.detail || "Sent to printer." });
        return;
      }
      setRowResult(row.id, { error: result.detail || "Print failed." });
      if (result.code === "no_printer") setSaveFor(row.id);
    } catch (err) {
      setRowResult(row.id, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setPrintingId(null);
    }
  }

  async function saveFile(row: ReceiptRow) {
    try {
      const saved = await saveReceiptFile(rowPayload(row, settings), settings, branding);
      setRowResult(row.id, { msg: `Saved receipt to ${saved.path}` });
      setSaveFor(null);
      setError("");
    } catch (err) {
      setRowResult(row.id, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function sendEmail(row: ReceiptRow) {
    const to = email.trim();
    if (!to || !row.ticket_id) {
      setRowResult(row.id, { error: "Email needs a ticket and address." });
      return;
    }
    try {
      const res = await callFunction("email-receipt", {
        method: "POST",
        body: JSON.stringify({ ticketId: row.ticket_id, toEmail: to }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Email failed (${res.status})`);
      setRowResult(row.id, { msg: `Receipt emailed to ${to}` });
      setEmailFor(null);
      setEmail("");
      setError("");
    } catch (err) {
      setRowResult(row.id, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function confirmVoid() {
    if (!voidTicketId) return;
    setError("");
    setMsg("");
    try {
      let approval: string | null = null;
      if (!isAdmin) {
        approval = await approveWithPin("void_ticket", rows.find((r) => r.ticket_id === voidTicketId)?.sku || "", pin, voidTicketId);
      }
      // Fetch the whole ticket, independent of search results or pagination.
      const { data: sales, error: salesError } = await floorCloud().from("sales")
        .select("payment_method").eq("ticket_id", voidTicketId);
      if (salesError) throw salesError;
      const method = sales?.[0]?.payment_method;
      if (!method) throw new Error("Ticket not found.");
      let message = "Ticket voided.";
      if (method === "card" || method === "split") {
        const { data: extras, error: extrasError } = await floorCloud().from("ticket_extras")
          .select("card_cents, cash_cents").eq("ticket_id", voidTicketId).single();
        if (extrasError) throw extrasError;
        message = manualRefundMessage(method, extras.card_cents, extras.cash_cents);
      }
      await voidTicket(voidTicketId, "void last ticket", approval);
      setMsg(message);
      setRows(current => current.map(row => row.ticket_id === voidTicketId ? { ...row, voided_at: new Date().toISOString() } : row));
      setVoidTicketId(null);
      setPin("");
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
              {rowStatus[row.id]?.error ? <p className="error">{rowStatus[row.id].error}</p> : null}
              {!rowStatus[row.id]?.error && rowStatus[row.id]?.msg ? <p>{rowStatus[row.id].msg}</p> : null}
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
              <button
                type="button"
                disabled={Boolean(row.voided_at) || printingId === row.id}
                onClick={() => void reprint(row)}
              >
                {printingId === row.id ? "Printing…" : "Reprint"}
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
