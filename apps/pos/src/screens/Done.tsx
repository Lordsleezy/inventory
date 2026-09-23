import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatCentsTotal } from "@floor/store";
import type { TicketSummary } from "@floor/cloud";
import { usePos } from "../pos-context";
import { printTicketReceipt, ticketReceiptPayload } from "../sale-flow";
import { loadReceiptBranding, saveReceiptFile } from "../print-receipt";
import type { ReceiptBranding } from "../receipt";
import { callFunction } from "../functions";

type Stored = {
  summary: TicketSummary;
  changeCents: number | null;
  clerkName: string;
  titles: Record<string, { title: string; condition: string | null }>;
  customerEmail?: string | null;
};

export function DoneScreen() {
  const { ticketId = "" } = useParams();
  const { settings, online } = usePos();
  const navigate = useNavigate();
  const [branding, setBranding] = useState<ReceiptBranding | null>(null);
  const [stored, setStored] = useState<Stored | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offerSave, setOfferSave] = useState(false);

  useEffect(() => {
    const raw = sessionStorage.getItem(`floor_ticket_${ticketId}`);
    if (!raw) return;
    try {
      setStored(JSON.parse(raw) as Stored);
    } catch {
      setStored(null);
    }
  }, [ticketId]);

  useEffect(() => {
    if (!online) return;
    void loadReceiptBranding()
      .then(setBranding)
      .catch(() => setBranding(null));
  }, [online]);

  if (!stored) {
    return (
      <section className="page">
        <p className="error">Sale summary not found on this register.</p>
        <button type="button" onClick={() => navigate("/")}>
          New sale
        </button>
      </section>
    );
  }

  const { summary, changeCents, clerkName, titles, customerEmail } = stored;
  const meta = {
    clerkName,
    changeCents,
    titles,
    reviewUrl: settings.reviewUrl || null,
    legal: settings.receiptLegal,
    branding,
  };

  async function onPrint() {
    setBusy(true);
    setMsg("");
    setError("");
    setOfferSave(false);
    try {
      const result = await printTicketReceipt(summary, meta, settings);
      if (result.printed) {
        setMsg(result.detail || "Printed.");
        return;
      }
      setError(result.detail || "Print did not complete.");
      if (result.code === "no_printer") setOfferSave(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSaveFile() {
    setBusy(true);
    setMsg("");
    setError("");
    try {
      const saved = await saveReceiptFile(ticketReceiptPayload(summary, meta), settings, branding);
      setMsg(`Saved receipt to ${saved.path}`);
      setOfferSave(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onEmail() {
    const prefill = customerEmail || "";
    const address = window.prompt("Email receipt to:", prefill);
    if (!address?.trim()) return;
    setBusy(true);
    setMsg("");
    setError("");
    try {
      const res = await callFunction("email-receipt", {
        method: "POST",
        body: JSON.stringify({
          ticketId: summary.ticket_id,
          toEmail: address.trim(),
          email: address.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || body.message || `email-receipt HTTP ${res.status}`);
      }
      setMsg(`Receipt emailed to ${address.trim()}.`);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Email failed: ${err.message}. (Netlify function email-receipt may not be deployed yet.)`
          : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page grid">
      <h1>Sale complete</h1>
      <p className="muted">Ticket {summary.ticket_id.slice(0, 8)}…</p>
      {summary.lines.map((l) => (
        <div className="card row" key={l.sale_id}>
          <div>
            <strong>
              {l.receipt_no} · {l.sku}
            </strong>
            <div>{titles[l.sku]?.title || "Item"}</div>
          </div>
          <span>{formatCentsTotal(l.price_cents + l.tax_cents)}</span>
        </div>
      ))}
      <div className="card">
        <div className="row">
          <span>Subtotal</span>
          <span>{formatCentsTotal(summary.subtotal_cents)}</span>
        </div>
        {summary.discount_cents ? (
          <div className="row">
            <span>Discount</span>
            <span>−{formatCentsTotal(summary.discount_cents)}</span>
          </div>
        ) : null}
        <div className="row">
          <span>Tax</span>
          <span>{formatCentsTotal(summary.tax_cents)}</span>
        </div>
        {summary.card_fee_cents ? (
          <div className="row">
            <span>Card fee</span>
            <span>{formatCentsTotal(summary.card_fee_cents)}</span>
          </div>
        ) : null}
        <div className="row price">
          <span>Total</span>
          <span>{formatCentsTotal(summary.total_cents)}</span>
        </div>
        {summary.payment_method === "split" ? (
          <div className="row muted">
            <span>Tender</span>
            <span>
              cash {formatCentsTotal(summary.cash_cents ?? 0)} · card{" "}
              {formatCentsTotal(summary.card_cents ?? 0)}
            </span>
          </div>
        ) : null}
        {changeCents != null ? (
          <div className="row">
            <span>Change</span>
            <span>{formatCentsTotal(changeCents)}</span>
          </div>
        ) : null}
        {summary.points_earned ? (
          <div className="row muted">
            <span>Points earned</span>
            <span>{summary.points_earned}</span>
          </div>
        ) : null}
        {summary.payment_method === "card" || summary.payment_method === "split" ? (
          summary.card_brand || summary.card_last4 ? (
            <div className="row">
              <span>Card</span>
              <span>
                {[summary.card_brand, summary.card_last4 ? `•••• ${summary.card_last4}` : null]
                  .filter(Boolean)
                  .join(" ")}
              </span>
            </div>
          ) : null
        ) : null}
      </div>
      {msg ? <p>{msg}</p> : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="primary" disabled={busy} onClick={() => void onPrint()}>
          Print
        </button>
        {offerSave ? (
          <button type="button" disabled={busy} onClick={() => void onSaveFile()}>
            Save as PDF/file
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={() => void onEmail()}>
          Email
        </button>
        <button type="button" disabled={busy} onClick={() => navigate("/", { replace: true })}>
          No receipt
        </button>
      </div>
      <button type="button" onClick={() => navigate("/receipts")}>
        Past sales
      </button>
    </section>
  );
}
