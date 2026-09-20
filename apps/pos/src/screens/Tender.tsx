import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatCentsTotal, parseMoneyToCents } from "@floor/store";
import {
  allocateLineTaxes,
  approveWithPin,
  authErrorMessage,
  finalizeTicket,
  SellError,
  type TicketSummary,
} from "@floor/cloud";
import { useCart } from "../cart";
import { usePos } from "../pos-context";
import { printReceipt } from "../print-receipt";
import { type ReceiptPayload } from "../receipt";
import { callFunction } from "../functions";
import type { PosSettings } from "../local";

export function TenderScreen() {
  const { lines, clear } = useCart();
  const { session, taxRateBps, refreshUnits } = usePos();
  const navigate = useNavigate();
  const [tender, setTender] = useState<"cash" | "card">("cash");
  const [received, setReceived] = useState("");
  const [pin, setPin] = useState("");
  const [pinSku, setPinSku] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loud, setLoud] = useState("");

  const prices = lines.map((l) => l.priceCents);
  const taxes = useMemo(() => {
    if (taxRateBps == null || !prices.length) return [];
    return allocateLineTaxes(prices, taxRateBps);
  }, [prices.join(","), taxRateBps]);
  const subtotal = prices.reduce((a, b) => a + b, 0);
  const tax = taxes.reduce((a, b) => a + b, 0);
  const total = subtotal + tax;
  const receivedCents = parseMoneyToCents(received);
  const change =
    typeof receivedCents === "number" && tender === "cash" ? receivedCents - total : null;

  async function runSale(approvals: Record<string, string | null>) {
    if (!lines.length) return;
    if (taxRateBps == null) {
      setError("Set your tax rate in Settings before checkout.");
      return;
    }
    if (tender === "cash") {
      if (typeof receivedCents !== "number") {
        setError("Enter cash received.");
        return;
      }
      if (receivedCents < total) {
        setError("Cash received is less than the total.");
        return;
      }
    }
    if (tender === "card") {
      setError("Card tender is not wired yet. Use cash, or wait for the Square handoff.");
      return;
    }

    setBusy(true);
    setError("");
    setLoud("");
    const ticketId = crypto.randomUUID();
    try {
      const summary = await finalizeTicket({
        ticketId,
        paymentMethod: tender,
        amountTenderedCents: tender === "cash" ? receivedCents : null,
        lines: lines.map((l) => ({
          sku: l.sku,
          priceCents: l.priceCents,
          overrideReason: l.overrideReason.trim() || null,
          approvalId: approvals[l.sku] ?? l.approvalId,
        })),
      });
      for (const sku of lines.map((l) => l.sku)) {
        try {
          await callFunction("ebay-withdraw", {
            method: "POST",
            body: JSON.stringify({ afterSale: true, sku }),
          });
        } catch {
          /* sync later */
        }
      }
      try {
        await refreshUnits();
      } catch {
        /* next refresh */
      }
      sessionStorage.setItem(
        `floor_ticket_${summary.ticket_id}`,
        JSON.stringify({
          summary,
          changeCents: change,
          clerkName: session.displayName,
          titles: Object.fromEntries(lines.map((l) => [l.sku, { title: l.title, condition: l.condition }])),
        }),
      );
      clear();
      navigate(`/done/${summary.ticket_id}`, { replace: true });
    } catch (err) {
      if (err instanceof SellError && err.code === "below_floor") {
        const m = err.message.match(/below_floor\s+(\d+)/i);
        setPinSku(m?.[1] ?? lines[0]?.sku ?? null);
        setError(err.message);
      } else if (err instanceof SellError && err.code === "double_sell") {
        setLoud(err.message);
      } else if (err instanceof SellError && err.code === "not_sellable") {
        setLoud(err.message);
      } else {
        setError(authErrorMessage(err));
      }
      // Nothing sold — server rolled back; do not queue outbox.
    } finally {
      setBusy(false);
    }
  }

  async function submitPin() {
    if (!pinSku || !pin) return;
    try {
      const id = await approveWithPin("below_floor", pinSku, pin);
      setPinSku(null);
      setPin("");
      await runSale({ [pinSku]: id });
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  if (!lines.length) {
    return (
      <section className="page">
        <p className="muted">Cart is empty.</p>
        <button type="button" onClick={() => navigate("/")}>
          Search
        </button>
      </section>
    );
  }

  return (
    <section className="page grid">
      <button type="button" onClick={() => navigate("/cart")}>
        Back to cart
      </button>
      <h1>Payment</h1>
      {loud ? <div className="incident">{loud}</div> : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="card">
        <div className="row">
          <span>Subtotal</span>
          <span>{formatCentsTotal(subtotal)}</span>
        </div>
        <div className="row">
          <span>Tax</span>
          <span>{formatCentsTotal(tax)}</span>
        </div>
        <div className="row price">
          <span>Total</span>
          <span>{formatCentsTotal(total)}</span>
        </div>
      </div>
      <div className="row">
        <button type="button" className={tender === "cash" ? "primary" : ""} onClick={() => setTender("cash")}>
          Cash
        </button>
        <button type="button" className={tender === "card" ? "primary" : ""} onClick={() => setTender("card")}>
          Card
        </button>
      </div>
      {tender === "cash" ? (
        <label>
          Cash received
          <input value={received} onChange={(e) => setReceived(e.target.value)} inputMode="decimal" autoFocus />
        </label>
      ) : null}
      {change != null && change >= 0 ? <p className="price">Change due {formatCentsTotal(change)}</p> : null}
      <button type="button" className="primary" disabled={busy} onClick={() => void runSale({})}>
        {busy ? "Recording…" : "Complete sale"}
      </button>
      <p className="muted">If this fails, nothing is sold. Fix the error and try again — do not take money twice.</p>

      {pinSku ? (
        <div className="modal">
          <div className="card grid">
            <h2>Manager PIN</h2>
            <p className="muted">Below floor on SKU {pinSku}.</p>
            <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
            <div className="row">
              <button type="button" onClick={() => setPinSku(null)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void submitPin()}>
                Approve
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export async function printTicketReceipt(
  summary: TicketSummary,
  meta: {
    clerkName: string;
    changeCents: number | null;
    titles: Record<string, { title: string; condition: string | null }>;
    reviewUrl: string | null;
    legal: string;
  },
  settings: PosSettings,
) {
  const first = summary.lines[0];
  const payload: ReceiptPayload = {
    receiptNo: first?.receipt_no || summary.ticket_id.slice(0, 8),
    soldAt: new Date().toLocaleString(),
    clerkName: meta.clerkName,
    sku: summary.lines.map((l) => l.sku).join(", "),
    title: summary.lines
      .map((l) => `${l.sku} ${meta.titles[l.sku]?.title || ""} ${formatCentsTotal(l.price_cents)}`)
      .join("\n"),
    condition: null,
    priceCents: summary.subtotal_cents,
    taxCents: summary.tax_cents,
    totalCents: summary.total_cents,
    tender:
      (summary.payment_method || "CASH").toUpperCase() +
      (meta.changeCents != null ? ` · change ${formatCentsTotal(meta.changeCents)}` : ""),
    reviewUrl: meta.reviewUrl,
    legal: meta.legal,
    lines: summary.lines.map((l) => ({
      sku: l.sku,
      title: meta.titles[l.sku]?.title || "Item",
      condition: meta.titles[l.sku]?.condition ?? null,
      priceCents: l.price_cents,
      taxCents: l.tax_cents,
    })),
  };
  await printReceipt(payload, settings);
}
