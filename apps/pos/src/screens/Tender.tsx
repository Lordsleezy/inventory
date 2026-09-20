import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatCentsTotal, parseMoneyToCents } from "@floor/store";
import {
  allocateLineTaxes,
  approveWithPin,
  authErrorMessage,
  finalizeTicket,
  floorCloud,
  SellError,
  type TicketSummary,
} from "@floor/cloud";
import { useCart } from "../cart";
import { usePos } from "../pos-context";
import { printReceipt } from "../print-receipt";
import { type ReceiptPayload } from "../receipt";
import { callFunction } from "../functions";
import type { PosSettings } from "../local";
import {
  cancelCharge,
  createTicketCharge,
  finalizeCapturedCharge,
  refundFailedCharge,
  waitForCharge,
} from "../card-device";

type Phase = "idle" | "waiting_phone" | "finalizing" | "recovering";

export function TenderScreen() {
  const { lines, clear } = useCart();
  const { session, taxRateBps, refreshUnits } = usePos();
  const navigate = useNavigate();
  const [tender, setTender] = useState<"cash" | "card">("cash");
  const [received, setReceived] = useState("");
  const [pin, setPin] = useState("");
  const [pinSku, setPinSku] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [loud, setLoud] = useState("");
  const [waitHint, setWaitHint] = useState("");
  const [orphan, setOrphan] = useState<{
    id: string;
    payment_id: string | null;
    amount_cents: number;
    status: string;
    error: string | null;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chargeIdRef = useRef<string | null>(null);

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

  useEffect(() => {
    let stop = false;
    void (async () => {
      const { data } = await floorCloud()
        .from("card_charges")
        .select("id, payment_id, amount_cents, status, error")
        .in("status", ["captured", "finalize_failed"])
        .order("created_at", { ascending: false })
        .limit(1);
      if (!stop && data?.[0]) setOrphan(data[0] as NonNullable<typeof orphan>);
    })();
    return () => {
      stop = true;
    };
  }, []);

  async function recoverOrphan(action: "finalize" | "refund") {
    if (!orphan) return;
    setBusy(true);
    setPhase("recovering");
    setError("");
    setLoud("");
    try {
      if (action === "finalize") {
        const summary = (await finalizeCapturedCharge(orphan.id)) as TicketSummary & {
          ok?: boolean;
          error?: string;
          needs_refund?: boolean;
          payment_id?: string;
          amount_cents?: number;
          ticket_id?: string;
        };
        if (summary && summary.ok === false) {
          setLoud(`Finalize still failing: ${summary.error || "unknown"}. Refund if the card was charged.`);
          return;
        }
        setOrphan(null);
        if (summary?.ticket_id) {
          sessionStorage.setItem(
            `floor_ticket_${summary.ticket_id}`,
            JSON.stringify({ summary, changeCents: null, clerkName: session.displayName, titles: {} }),
          );
          navigate(`/done/${summary.ticket_id}`, { replace: true });
        } else {
          setLoud("Recovered — sale finalized.");
        }
        return;
      }
      await refundFailedCharge({
        chargeId: orphan.id,
        paymentId: orphan.payment_id,
        amountCents: orphan.amount_cents,
        reason: orphan.error || "manual_recovery_refund",
      });
      setOrphan(null);
      setLoud("Refunded the orphaned card capture. Inventory was not sold.");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  }

  function ticketLines(approvals: Record<string, string | null>) {
    return lines.map((l) => ({
      sku: l.sku,
      priceCents: l.priceCents,
      overrideReason: l.overrideReason.trim() || null,
      approvalId: approvals[l.sku] ?? l.approvalId,
    }));
  }

  async function afterSale(summary: TicketSummary, changeCents: number | null) {
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
        changeCents,
        clerkName: session.displayName,
        titles: Object.fromEntries(lines.map((l) => [l.sku, { title: l.title, condition: l.condition }])),
      }),
    );
    clear();
    navigate(`/done/${summary.ticket_id}`, { replace: true });
  }

  async function runCash(approvals: Record<string, string | null>) {
    if (typeof receivedCents !== "number") {
      setError("Enter cash received.");
      return;
    }
    if (receivedCents < total) {
      setError("Cash received is less than the total.");
      return;
    }
    setBusy(true);
    setError("");
    setLoud("");
    const ticketId = crypto.randomUUID();
    try {
      const summary = await finalizeTicket({
        ticketId,
        paymentMethod: "cash",
        amountTenderedCents: receivedCents,
        lines: ticketLines(approvals),
      });
      await afterSale(summary, change);
    } catch (err) {
      handleSaleError(err);
    } finally {
      setBusy(false);
      setPhase("idle");
    }
  }

  async function runCard(approvals: Record<string, string | null>) {
    setBusy(true);
    setError("");
    setLoud("");
    setWaitHint("");
    const ticketId = crypto.randomUUID();
    const abort = new AbortController();
    abortRef.current = abort;
    let chargeId: string | null = null;
    let paymentId: string | null = null;
    try {
      setPhase("waiting_phone");
      setWaitHint("Sending ticket to the phone reader…");
      const created = await createTicketCharge(ticketId, ticketLines(approvals));
      chargeId = created.id;
      chargeIdRef.current = chargeId;

      if (created.status === "finalized" && created.summary) {
        await afterSale(created.summary as TicketSummary, null);
        return;
      }

      setWaitHint(
        `Waiting on phone — charge ${formatCentsTotal(created.amountCents)}. Customer can tap/insert on the reader.`,
      );
      const paid = await waitForCharge(chargeId, { signal: abort.signal, timeoutMs: 180_000 });
      if (!paid.ok) {
        if (paid.reason === "canceled") {
          setError("Card payment canceled.");
        } else if (paid.reason === "declined") {
          setError("Card declined. Nothing was sold.");
        } else if (paid.reason === "timeout") {
          await cancelCharge(chargeId).catch(() => {});
          setError("Timed out waiting for the phone. Nothing was sold.");
        } else {
          setError("Card payment failed. Nothing was sold.");
        }
        return;
      }
      paymentId = paid.paymentId;

      setPhase("finalizing");
      setWaitHint("Card captured — recording the sale…");
      const summary = (await finalizeCapturedCharge(chargeId)) as TicketSummary & {
        ok?: boolean;
        error?: string;
        needs_refund?: boolean;
        payment_id?: string;
        amount_cents?: number;
      };
      if (summary && summary.ok === false) {
        try {
          await refundFailedCharge({
            chargeId,
            paymentId: summary.payment_id || paymentId,
            amountCents: summary.amount_cents || created.amountCents,
            reason: String(summary.error || "finalize_failed"),
          });
          setLoud(
            `Sale could not finish (${summary.error || "error"}). The card payment was refunded. Inventory was not marked sold.`,
          );
        } catch (refundErr) {
          setLoud(
            `Sale failed after card capture, and automatic refund failed. Check Square Dashboard for payment ${paymentId}. ${authErrorMessage(refundErr)}`,
          );
        }
        return;
      }
      await afterSale(summary as TicketSummary, null);
    } catch (err) {
      const code = (err as Error & { code?: string }).code || (err instanceof SellError ? err.code : "");
      if (code === "reader_not_paired" || (err instanceof Error && /reader_not_paired/i.test(err.message))) {
        setError("Pair a phone reader in Settings before taking cards.");
      } else if (code === "reader_offline" || (err instanceof Error && /reader_offline/i.test(err.message))) {
        setError("Phone reader is offline. Open Payment device on the phone and try again.");
      } else {
        handleSaleError(err);
      }
      if (chargeId) await cancelCharge(chargeId).catch(() => {});
    } finally {
      abortRef.current = null;
      chargeIdRef.current = null;
      setBusy(false);
      setPhase("idle");
      setWaitHint("");
    }
  }

  function handleSaleError(err: unknown) {
    if (err instanceof SellError && err.code === "below_floor") {
      const m = err.message.match(/below_floor\s+(\d+)/i);
      setPinSku(m?.[1] ?? lines[0]?.sku ?? null);
      setError(err.message);
    } else if (err instanceof SellError && (err.code === "double_sell" || err.code === "not_sellable")) {
      setLoud(err.message);
    } else {
      setError(authErrorMessage(err));
    }
  }

  async function runSale(approvals: Record<string, string | null>) {
    if (!lines.length) return;
    if (taxRateBps == null) {
      setError("Set your tax rate in Settings before checkout.");
      return;
    }
    if (tender === "cash") await runCash(approvals);
    else await runCard(approvals);
  }

  async function cancelWaiting() {
    abortRef.current?.abort();
    const id = chargeIdRef.current;
    if (id) await cancelCharge(id).catch(() => {});
    setPhase("idle");
    setBusy(false);
    setWaitHint("");
    setError("Canceled. Nothing was sold.");
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
      <section className="page grid">
        <p className="muted">Cart is empty.</p>
        {orphan ? (
          <div className="card grid">
            <strong>Unfinished card charge</strong>
            <p className="muted">
              Status {orphan.status} · {formatCentsTotal(orphan.amount_cents)}
              {orphan.payment_id ? ` · payment ${orphan.payment_id}` : ""}.
              The phone may have charged the card before the sale finished.
            </p>
            {loud ? <div className="incident">{loud}</div> : null}
            {error ? <p className="error">{error}</p> : null}
            <div className="row">
              <button type="button" className="primary" disabled={busy} onClick={() => void recoverOrphan("finalize")}>
                Finalize sale
              </button>
              <button type="button" className="danger" disabled={busy} onClick={() => void recoverOrphan("refund")}>
                Refund card
              </button>
            </div>
          </div>
        ) : null}
        <button type="button" onClick={() => navigate("/")}>
          Search
        </button>
      </section>
    );
  }

  return (
    <section className="page grid">
      <button type="button" onClick={() => navigate("/cart")} disabled={phase !== "idle"}>
        Back to cart
      </button>
      <h1>Payment</h1>
      {loud ? <div className="incident">{loud}</div> : null}
      {error ? <p className="error">{error}</p> : null}
      {orphan ? (
        <div className="card grid">
          <strong>Unfinished card charge</strong>
          <p className="muted">
            Status {orphan.status} · {formatCentsTotal(orphan.amount_cents)}. Finish or refund before a new sale.
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void recoverOrphan("finalize")}>
              Finalize sale
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => void recoverOrphan("refund")}>
              Refund card
            </button>
          </div>
        </div>
      ) : null}
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
        <button
          type="button"
          className={tender === "cash" ? "primary" : ""}
          disabled={phase !== "idle"}
          onClick={() => setTender("cash")}
        >
          Cash
        </button>
        <button
          type="button"
          className={tender === "card" ? "primary" : ""}
          disabled={phase !== "idle"}
          onClick={() => setTender("card")}
        >
          Card
        </button>
      </div>
      {tender === "cash" ? (
        <label>
          Cash received
          <input value={received} onChange={(e) => setReceived(e.target.value)} inputMode="decimal" autoFocus />
        </label>
      ) : (
        <p className="muted">Card charges the tax-included total on the paired phone reader (Square sandbox).</p>
      )}
      {change != null && change >= 0 ? <p className="price">Change due {formatCentsTotal(change)}</p> : null}

      {phase === "waiting_phone" || phase === "finalizing" ? (
        <div className="card grid">
          <strong>{phase === "finalizing" ? "Recording sale…" : "Waiting on phone"}</strong>
          <p>{waitHint}</p>
          {phase === "waiting_phone" ? (
            <button type="button" className="danger" onClick={() => void cancelWaiting()}>
              Cancel card payment
            </button>
          ) : null}
        </div>
      ) : (
        <button type="button" className="primary" disabled={busy} onClick={() => void runSale({})}>
          {busy ? "Working…" : tender === "card" ? "Charge card on phone" : "Complete sale"}
        </button>
      )}
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
  const cardBits = [summary.card_brand, summary.card_last4 ? `•••• ${summary.card_last4}` : null]
    .filter(Boolean)
    .join(" ");
  const tenderLabel =
    (summary.payment_method || "CASH").toUpperCase() +
    (cardBits ? ` · ${cardBits}` : "") +
    (meta.changeCents != null ? ` · change ${formatCentsTotal(meta.changeCents)}` : "");
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
    tender: tenderLabel,
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
