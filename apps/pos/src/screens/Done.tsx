import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { formatCentsTotal } from "@floor/store";
import type { TicketSummary } from "@floor/cloud";
import { usePos } from "../pos-context";
import { printTicketReceipt } from "./Tender";

type Stored = {
  summary: TicketSummary;
  changeCents: number | null;
  clerkName: string;
  titles: Record<string, { title: string; condition: string | null }>;
};

export function DoneScreen() {
  const { ticketId = "" } = useParams();
  const { settings } = usePos();
  const navigate = useNavigate();
  const [stored, setStored] = useState<Stored | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const raw = sessionStorage.getItem(`floor_ticket_${ticketId}`);
    if (!raw) return;
    try {
      setStored(JSON.parse(raw) as Stored);
    } catch {
      setStored(null);
    }
  }, [ticketId]);

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

  const { summary, changeCents, clerkName, titles } = stored;

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
        <div className="row">
          <span>Tax</span>
          <span>{formatCentsTotal(summary.tax_cents)}</span>
        </div>
        <div className="row price">
          <span>Total</span>
          <span>{formatCentsTotal(summary.total_cents)}</span>
        </div>
        {changeCents != null ? (
          <div className="row">
            <span>Change</span>
            <span>{formatCentsTotal(changeCents)}</span>
          </div>
        ) : null}
      </div>
      {msg ? <p>{msg}</p> : null}
      <div className="row">
        <button
          type="button"
          className="primary"
          onClick={() =>
            void printTicketReceipt(summary, {
              clerkName,
              changeCents,
              titles,
              reviewUrl: settings.reviewUrl || null,
              legal: settings.receiptLegal,
            }, settings).then(() => setMsg("Sent to printer."))
          }
        >
          Print receipt
        </button>
        <button type="button" onClick={() => navigate("/", { replace: true })}>
          Skip / new sale
        </button>
      </div>
      <button type="button" onClick={() => navigate("/receipts")}>
        Past sales
      </button>
    </section>
  );
}
