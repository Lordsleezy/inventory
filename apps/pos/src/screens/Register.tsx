import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { centsToInput, formatCents, formatCentsTotal, parseMoneyToCents } from "@floor/store";
import {
  allocateLineTaxes,
  applyTicketDiscount,
  approveWithPin,
  authErrorMessage,
  cardFeeCents,
  finalizeTicket,
  quoteTicketTotals,
  type TicketQuote,
  lookupCustomerByPhone,
  SellError,
  upsertCustomer,
  type Customer,
  type TicketSummary,
} from "@floor/cloud";
import { useCart, type CartLine } from "../cart";
import { usePos } from "../pos-context";
import { searchUnits, type CachedUnit } from "../local";
import { unitThumbUrl } from "../unit-photo";
import {
  withdrawListingsAfterSale,
  type SalePhase,
} from "../sale-flow";
import { callFunction } from "../functions";

type ManualPayment = {
  quote: TicketQuote;
  args: Parameters<typeof finalizeTicket>[0];
  titles: Record<string, { title: string; condition: string | null }>;
  customerEmail: string | null;
};

type PinKind = "below_floor" | "ticket_discount";

function lineExtendedPrice(line: CartLine): number {
  return line.priceCents * (line.qty || 1);
}

export function RegisterScreen() {
  const {
    lines,
    note,
    setNote,
    ticketId,
    addUnit,
    removeSku,
    updateLine,
    setQty,
    clear,
  } = useCart();
  const { session, taxRateBps, online, refreshUnits, rewards, isAdmin } = usePos();
  const navigate = useNavigate();

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<CachedUnit[]>([]);
  const [showHits, setShowHits] = useState(false);
  const [error, setError] = useState("");
  const [loud, setLoud] = useState("");
  const [busy, setBusy] = useState(false);
  const manualKey = `floor_manual_${session.storeId}_${session.userId}`;
  const [manual, setManual] = useState<ManualPayment | null>(() => {
    try { return JSON.parse(localStorage.getItem(manualKey) || "null"); } catch { return null; }
  });
  const [phase, setPhase] = useState<SalePhase>(manual ? "manual_card" : "idle");
  const confirming = useRef(false);
  const [cashDigits, setCashDigits] = useState("");
  const [discountPct, setDiscountPct] = useState(0);
  const [discountApprovalId, setDiscountApprovalId] = useState<string | null>(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [discountDraft, setDiscountDraft] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [editSku, setEditSku] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitCashDraft, setSplitCashDraft] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [signupOpen, setSignupOpen] = useState(false);
  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupMarketing, setSignupMarketing] = useState(false);
  const [redeemPoints, setRedeemPoints] = useState(0);
  const [pinKind, setPinKind] = useState<PinKind | null>(null);
  const [pinSku, setPinSku] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [pendingAction, setPendingAction] = useState<"cash" | "card" | "split" | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      void searchUnits(q).then((rows) => {
        setHits(rows.slice(0, 12));
        setShowHits(Boolean(q.trim()));
      });
    }, 60);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    for (const line of lines) {
      if (line.sku in thumbs) continue;
      void unitThumbUrl(line.sku).then((url) => {
        setThumbs((prev) => ({ ...prev, [line.sku]: url }));
      });
    }
  }, [lines, thumbs]);

  const discountBps = Math.round(discountPct * 100);
  const extendedPrices = lines.map(lineExtendedPrice);
  const discountPreview = useMemo(
    () => applyTicketDiscount(extendedPrices, discountBps),
    [extendedPrices.join(","), discountBps],
  );
  const discounted = discountPreview.discounted;
  const discountCents = discountPreview.discountCents;

  const signupPreviewCents = useMemo(() => {
    if (!customer || customer.first_purchase_discount_used) return 0;
    const afterTicket = discounted.reduce((a, b) => a + b, 0);
    return Math.round((afterTicket * rewards.rewardsSignupDiscountBps) / 10_000);
  }, [customer, discounted.join(","), rewards.rewardsSignupDiscountBps]);

  const customerBalance = customer?.balance ?? 0;
  const creditAvailable =
    customer?.credit_cents ?? customerBalance * rewards.rewardsPointValueCents;
  const redeemCents = Math.min(
    redeemPoints * rewards.rewardsPointValueCents,
    Math.max(0, discounted.reduce((a, b) => a + b, 0) - signupPreviewCents),
  );
  const earnPreview = Math.floor(
    (Math.max(0, discounted.reduce((a, b) => a + b, 0) - signupPreviewCents - redeemCents) *
      rewards.rewardsPointsPerDollar) /
      100,
  );

  const taxableSubtotal = Math.max(
    0,
    discounted.reduce((a, b) => a + b, 0) - signupPreviewCents - redeemCents,
  );
  const taxes = useMemo(() => {
    if (taxRateBps == null || !discounted.length) return discounted.map(() => 0);
    try {
      const scale = discounted.reduce((a, b) => a + b, 0);
      const adjusted =
        scale > 0
          ? discounted.map((p) => Math.round((p * taxableSubtotal) / scale))
          : discounted;
      return allocateLineTaxes(adjusted, taxRateBps);
    } catch {
      return discounted.map(() => 0);
    }
  }, [discounted.join(","), taxRateBps, taxableSubtotal]);

  const rawSubtotal = extendedPrices.reduce((a, b) => a + b, 0);
  const tax = taxes.reduce((a, b) => a + b, 0);
  const total = taxableSubtotal + tax;
  const cardFeeBps = rewards.cardFeeBps;
  const cardFeePreview = cardFeeCents(total, cardFeeBps);
  const cardTotal = total + cardFeePreview;
  const itemCount = lines.reduce((a, l) => a + (l.qty || 1), 0);
  const cashTendered = cashDigits ? Number(cashDigits) : null;
  const change =
    cashTendered != null && Number.isFinite(cashTendered) ? cashTendered - total : null;

  function ticketLines(approvals: Record<string, string | null>) {
    return lines.map((l) => ({
      sku: l.sku,
      priceCents: l.priceCents,
      qty: l.qty || 1,
      overrideReason: l.overrideReason.trim() || null,
      approvalId: approvals[l.sku] ?? l.approvalId,
    }));
  }

  function validateCart(): string | null {
    if (!lines.length) return "Cart is empty.";
    if (taxRateBps == null) return "Set your tax rate in Settings before checkout.";
    for (const line of lines) {
      if (line.askCents != null && line.priceCents !== line.askCents && !line.overrideReason.trim()) {
        return `SKU ${line.sku}: enter a reason when the price differs from ask.`;
      }
    }
    if (discountBps > rewards.clerkMaxDiscountBps && !discountApprovalId && !isAdmin) {
      return "Discount above clerk max needs manager PIN.";
    }
    return null;
  }

  async function afterSale(summary: TicketSummary, changeCents: number | null, saved?: ManualPayment) {
    await withdrawListingsAfterSale(summary.lines.map((l) => l.sku));
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
        titles: saved?.titles ?? Object.fromEntries(lines.map((l) => [l.sku, { title: l.title, condition: l.condition }])),
        customerEmail: saved?.customerEmail ?? customer?.email ?? null,
      }),
    );
    clear();
    setCashDigits("");
    setDiscountPct(0);
    setDiscountApprovalId(null);
    setCustomer(null);
    setCustomerPhone("");
    setRedeemPoints(0);
    navigate(`/done/${summary.ticket_id}`, { replace: true });
  }

  function handleSaleError(err: unknown) {
    if (err instanceof SellError && err.code === "below_floor") {
      const m = err.message.match(/below_floor\s+(\d+)/i);
      setPinKind("below_floor");
      setPinSku(m?.[1] ?? lines[0]?.sku ?? null);
      setError(err.message);
    } else if (err instanceof SellError && (err.code === "double_sell" || err.code === "not_sellable")) {
      setLoud(err.message);
    } else {
      setError(authErrorMessage(err));
    }
  }

  async function runCash(approvals: Record<string, string | null>) {
    if (cashTendered == null || !Number.isFinite(cashTendered)) {
      setError("Enter cash received on the keypad.");
      return;
    }
    if (cashTendered < total) {
      setError("Cash received is less than the total.");
      return;
    }
    setBusy(true);
    setError("");
    setLoud("");
    try {
      const summary = await finalizeTicket({
        ticketId,
        paymentMethod: "cash",
        amountTenderedCents: cashTendered,
        cashCents: total,
        cardCents: 0,
        discountBps,
        discountApprovalId,
        customerId: customer?.id ?? null,
        redeemPoints,
        note: note.trim() || null,
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

  async function runCard(approvals: Record<string, string | null>, split?: { cashCents: number }) {
    setBusy(true);
    setPhase("quoting");
    setError("");
    try {
      const args = {
        ticketId, lines: ticketLines(approvals), paymentMethod: split ? "split" : "card",
        // Explicit local confirmation reference, never a Square payment ID.
        paymentId: `manual:${ticketId}`, discountBps, discountApprovalId,
        customerId: customer?.id ?? null, redeemPoints,
        cashCents: split?.cashCents ?? 0, note: note.trim() || null,
      };
      const quote = await quoteTicketTotals(args);
      if (quote.card_charge_cents <= 0) throw new Error("Cash covers the total. Use Cash instead.");
      const payment = { quote, args: { ...args, cardCents: quote.card_base_cents },
        titles: Object.fromEntries(lines.map(l => [l.sku, { title: l.title, condition: l.condition }])),
        customerEmail: customer?.email ?? null };
      localStorage.setItem(manualKey, JSON.stringify(payment));
      setManual(payment);
      setPhase("manual_card");
    } catch (err) {
      setPendingAction(split ? "split" : "card");
      handleSaleError(err);
      setPhase("idle");
    } finally { setBusy(false); }
  }

  async function completeManualCard() {
    if (!manual || confirming.current) return;
    confirming.current = true;
    setBusy(true);
    setPhase("finalizing");
    setError("");
    try {
      const summary = await finalizeTicket(manual.args);
      if (summary.total_cents !== manual.quote.total_cents) {
        window.alert(`Sale recorded for ${formatCentsTotal(summary.total_cents)}; the quoted total was ${formatCentsTotal(manual.quote.total_cents)}. Reconcile the difference in Square before continuing.`);
      }
      await afterSale(summary, null, manual);
      localStorage.removeItem(manualKey);
      setManual(null);
      setPhase("idle");
    } catch (err) {
      if (err instanceof SellError && err.code === "below_floor") handleSaleError(err);
      setError(`Sale not confirmed: ${authErrorMessage(err)}. Do not charge again. Retry to record this same ticket; if abandoning it, refund ${formatCentsTotal(manual.quote.card_charge_cents)} in the Square app.`);
      setPhase("manual_card");
    } finally { confirming.current = false; setBusy(false); }
  }

  async function startPay(kind: "cash" | "card" | "split", approvals: Record<string, string | null> = {}) {
    const err = validateCart();
    if (err) {
      if (err.includes("manager PIN")) {
        setPendingAction(kind);
        setPinKind("ticket_discount");
        setPinSku(lines[0]?.sku ?? "*");
        setError(err);
        return;
      }
      setError(err);
      return;
    }
    if (kind === "cash") await runCash(approvals);
    else if (kind === "card") await runCard(approvals);
    else setSplitOpen(true);
  }

  async function submitPin() {
    if (!pinKind || !pinSku || !pin) return;
    try {
      const id = await approveWithPin(pinKind, pinSku, pin, manual?.args.ticketId ?? ticketId);
      if (pinKind === "ticket_discount") {
        setDiscountApprovalId(id);
        setPinKind(null);
        setPinSku(null);
        setPin("");
        const action = pendingAction;
        setPendingAction(null);
        if (action) setError("Discount approved. Select the payment method again.");
        return;
      }
      setPinKind(null);
      setPinSku(null);
      setPin("");
      updateLine(pinSku, { approvalId: id });
      if (manual) {
        const approved = { ...manual, args: { ...manual.args, lines: manual.args.lines.map(line => line.sku === pinSku ? { ...line, approvalId: id } : line) } };
        localStorage.setItem(manualKey, JSON.stringify(approved));
        setManual(approved);
        setError("Approved. Click Card paid — complete sale again. Do not charge again.");
      } else {
        await startPay(pendingAction ?? "cash", { [pinSku]: id });
      }
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  function addFromSearch(unit: CachedUnit) {
    addUnit(unit);
    setQ("");
    setShowHits(false);
    setError("");
    searchRef.current?.focus();
  }

  function onSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && hits[0]) {
      e.preventDefault();
      addFromSearch(hits[0]);
    } else if (e.key === "Escape") {
      setShowHits(false);
    }
  }

  function pushDigit(d: string) {
    setCashDigits((prev) => {
      if (d === "C") return "";
      if (d === "⌫") return prev.slice(0, -1);
      if (prev.length >= 8) return prev;
      return prev + d;
    });
  }

  async function lookupCustomer() {
    setError("");
    try {
      const found = await lookupCustomerByPhone(customerPhone);
      if (found) {
        setCustomer(found);
        setRedeemPoints(0);
      } else {
        setCustomer(null);
        setSignupOpen(true);
        setSignupName("");
        setSignupEmail("");
      }
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  async function createCustomer() {
    setError("");
    try {
      const name = signupName.trim();
      const email = signupEmail.trim();
      if (!name || !email.includes("@")) {
        setError("Name and email — that’s it.");
        return;
      }
      const created = await upsertCustomer({
        phone: customerPhone,
        name,
        email,
        marketingOptIn: signupMarketing,
      });
      setCustomer(created);
      setSignupOpen(false);
      void callFunction("loyalty-email", {
        method: "POST",
        body: JSON.stringify({ action: "drain" }),
      }).catch(() => {});
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }

  function applyDiscountDraft() {
    const pct = Number(discountDraft);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError("Enter a discount percent between 0 and 100.");
      return;
    }
    setDiscountPct(pct);
    setDiscountApprovalId(null);
    setDiscountOpen(false);
  }

  async function confirmSplit() {
    const cashCents = parseMoneyToCents(splitCashDraft);
    if (typeof cashCents !== "number" || cashCents < 0) {
      setError("Enter a valid cash amount for split.");
      return;
    }
    if (cashCents >= total) {
      setError("Cash covers the full total — use Cash instead.");
      return;
    }
    setSplitOpen(false);
    await runCard({}, { cashCents });
  }

  const editLine = lines.find((l) => l.sku === editSku) ?? null;

  return (
    <section className="register">
      <div className="register-left">
        <div className="register-search-wrap">
          <input
            ref={searchRef}
            className="search"
            placeholder="Scan or search SKU, title, category…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => q.trim() && setShowHits(true)}
            onKeyDown={onSearchKey}
            autoFocus
            disabled={phase !== "idle"}
          />
          {showHits && hits.length ? (
            <div className="search-results">
              {hits.map((u) => (
                <button key={u.sku} type="button" className="search-hit" onClick={() => addFromSearch(u)}>
                  <span>
                    <strong>{u.sku}</strong>
                    <div>{[u.brand, u.model].filter(Boolean).join(" ") || u.title}</div>
                    <div className="muted">
                      {u.category || "—"} · {u.condition || "—"}
                      {u.qtyOnHand && u.qtyOnHand > 1 ? ` · qty ${u.qtyOnHand}` : ""}
                    </div>
                  </span>
                  <span className="price" style={{ fontSize: "1.1rem" }}>
                    {formatCents(u.askCents) || "—"}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="cart-panel">
          <table className="cart-table">
            <thead>
              <tr>
                <th style={{ width: 56 }} />
                <th>Item</th>
                <th>Qty</th>
                <th>Price</th>
                <th>Total</th>
                <th style={{ width: 88 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const thumb = thumbs[line.sku] ?? line.photoUrl;
                const multi = line.qtyOnHand > 1;
                return (
                  <tr key={line.sku}>
                    <td>
                      {thumb ? (
                        <img className="thumb" src={thumb} alt="" />
                      ) : (
                        <div className="thumb placeholder">—</div>
                      )}
                    </td>
                    <td>
                      <strong>{line.title}</strong>
                      <div className="muted">
                        {line.sku}
                        {line.condition ? ` · ${line.condition}` : ""}
                      </div>
                    </td>
                    <td>
                      {multi ? (
                        <div className="qty-stepper">
                          <button
                            type="button"
                            disabled={phase !== "idle" || line.qty <= 1}
                            onClick={() => setQty(line.sku, line.qty - 1)}
                          >
                            −
                          </button>
                          <span>{line.qty}</span>
                          <button
                            type="button"
                            disabled={phase !== "idle" || line.qty >= line.qtyOnHand}
                            onClick={() => setQty(line.sku, line.qty + 1)}
                          >
                            +
                          </button>
                        </div>
                      ) : (
                        <span>1</span>
                      )}
                    </td>
                    <td>{formatCentsTotal(line.priceCents)}</td>
                    <td>{formatCentsTotal(lineExtendedPrice(line))}</td>
                    <td>
                      <div className="cart-actions">
                        <button type="button" className="ghost" disabled={phase !== "idle"} onClick={() => setEditSku(line.sku)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={phase !== "idle"}
                          onClick={() => removeSku(line.sku)}
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!lines.length ? (
                <tr>
                  <td colSpan={6}>
                    <p className="muted" style={{ padding: "1.5rem" }}>
                      Search above to add items. One-of-one units have no quantity steppers.
                    </p>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button type="button" disabled={phase !== "idle"} onClick={() => setNoteOpen(true)}>
            Add Note{note ? " ✓" : ""}
          </button>
          <button
            type="button"
            className="danger"
            disabled={!lines.length || phase !== "idle"}
            onClick={() => {
              if (window.confirm("Clear the cart?")) clear();
            }}
          >
            Clear Cart
          </button>
          <button
            type="button"
            disabled={!online || phase !== "idle"}
            onClick={() => void refreshUnits().catch((err) => setError(String(err)))}
          >
            Refresh stock
          </button>
        </div>
      </div>

      <aside className="register-right">
        <div className="checkout-card">
          <strong>Checkout</strong>
          {loud ? <div className="incident">{loud}</div> : null}
          {error ? <p className="error">{error}</p> : null}

          <div className="summary-row">
            <span>Subtotal ({itemCount} item{itemCount === 1 ? "" : "s"})</span>
            <span>{formatCentsTotal(rawSubtotal)}</span>
          </div>
          <div className="summary-row">
            <span>
              Discount
              <button type="button" className="icon-btn" title="Edit discount" onClick={() => {
                setDiscountDraft(String(discountPct || ""));
                setDiscountOpen(true);
              }}>
                ✎
              </button>
            </span>
            <span>{discountCents ? `−${formatCentsTotal(discountCents)}` : formatCentsTotal(0)}</span>
          </div>
          {signupPreviewCents ? (
            <div className="summary-row muted">
              <span>New signup ({(rewards.rewardsSignupDiscountBps / 100).toFixed(0)}%)</span>
              <span>−{formatCentsTotal(signupPreviewCents)}</span>
            </div>
          ) : null}
          {redeemCents ? (
            <div className="summary-row muted">
              <span>Store credit</span>
              <span>−{formatCentsTotal(redeemCents)}</span>
            </div>
          ) : null}
          {customer && lines.length ? (
            <div className="summary-row muted">
              <span>Points this sale</span>
              <span>+{earnPreview}</span>
            </div>
          ) : null}
          <div className="summary-row">
            <span>Tax {taxRateBps != null ? `(${(taxRateBps / 100).toFixed(2)}%)` : ""}</span>
            <span>{formatCentsTotal(tax)}</span>
          </div>
          {cardFeeBps > 0 && lines.length ? (
            <div className="summary-row muted">
              <span>Card fee ({(cardFeeBps / 100).toFixed(2)}% — card only)</span>
              <span>{formatCentsTotal(cardFeePreview)}</span>
            </div>
          ) : null}
          <div className="summary-row checkout-total">
            <span>TOTAL</span>
            <span>{formatCentsTotal(total)}</span>
          </div>
          {cardFeeBps > 0 && lines.length ? (
            <div className="summary-row muted">
              <span>Card total</span>
              <span>{formatCentsTotal(cardTotal)}</span>
            </div>
          ) : null}

          {phase !== "idle" ? <p>{phase === "quoting" ? "Getting exact total…" : "Confirm payment below."}</p> : (
            <div className="pay-stack">
              <button type="button" className="cash" disabled={busy || !lines.length} onClick={() => void startPay("cash")}>
                CASH
              </button>
              <button type="button" className="card" disabled={busy || !lines.length} onClick={() => void startPay("card")}>
                CARD
              </button>
              <button type="button" disabled={busy || !lines.length} onClick={() => void startPay("split")}>
                Split Payment
              </button>
            </div>
          )}

          <div className="customer-block">
            <strong>Customer</strong>
            <div className="row" style={{ gap: "0.4rem" }}>
              <input
                placeholder="Phone"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void lookupCustomer();
                  }
                }}
                inputMode="tel"
                style={{ flex: 1 }}
              />
              <button type="button" onClick={() => void lookupCustomer()}>
                Find
              </button>
            </div>
            {customer ? (
              <div className="muted">
                {customer.name || "Customer"} · {customer.phone}
                <div>
                  {customerBalance} pts · {formatCentsTotal(creditAvailable)} store credit
                  {!customer.first_purchase_discount_used
                    ? ` · 5% new (${customer.signup_code || "on account"})`
                    : ""}
                </div>
                <button type="button" className="ghost" onClick={() => { setCustomer(null); setRedeemPoints(0); }}>
                  Clear
                </button>
              </div>
            ) : null}
            {customer && customerBalance > 0 ? (
              <div className="row" style={{ gap: "0.4rem", alignItems: "center" }}>
                <label style={{ flex: 1 }}>
                  Apply credit (points)
                  <input
                    type="number"
                    min={0}
                    max={customerBalance}
                    value={redeemPoints || ""}
                    onChange={(e) =>
                      setRedeemPoints(Math.max(0, Math.min(customerBalance, Number(e.target.value) || 0)))
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const maxBySub = rewards.rewardsPointValueCents
                      ? Math.floor(
                          Math.max(0, discounted.reduce((a, b) => a + b, 0) - signupPreviewCents) /
                            rewards.rewardsPointValueCents,
                        )
                      : 0;
                    setRedeemPoints(Math.min(customerBalance, maxBySub));
                  }}
                >
                  Apply all
                </button>
              </div>
            ) : null}
          </div>

          <div>
            <div className="summary-row">
              <span>Cash tendered</span>
              <span className="price" style={{ fontSize: "1.25rem" }}>
                {cashTendered != null ? formatCentsTotal(cashTendered) : "$0.00"}
              </span>
            </div>
            {change != null && change >= 0 ? (
              <div className="summary-row">
                <span>Change</span>
                <strong>{formatCentsTotal(change)}</strong>
              </div>
            ) : null}
            <div className="numpad" style={{ marginTop: "0.4rem" }}>
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"].map((d) => (
                <button key={d} type="button" disabled={phase !== "idle"} onClick={() => pushDigit(d)}>
                  {d}
                </button>
              ))}
            </div>
            <p className="muted" style={{ marginTop: "0.35rem" }}>
              Keypad enters cents (e.g. 2000 = $20.00).
            </p>
          </div>
        </div>
      </aside>

      {manual ? (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Manual card payment">
          <div className="card grid">
            <h2>Charge in the Square app</h2>
            <strong style={{ fontSize: "3.5rem" }}>{formatCentsTotal(manual.quote.card_charge_cents)}</strong>
            <p>Tax {formatCentsTotal(manual.quote.tax_cents)} · Card fee {formatCentsTotal(manual.quote.card_fee_cents)} (included)</p>
            {manual.args.paymentMethod === "split" ? <p>Collect {formatCentsTotal(manual.args.cashCents!)} cash in the drawer.</p> : null}
            <p>Charge the exact amount above on your phone. Confirm only after Square says paid.</p>
            {error ? <p className="error">{error}</p> : null}
            <button className="primary" disabled={busy} onClick={() => void completeManualCard()}>{busy ? "Recording sale…" : "Card paid — complete sale"}</button>
            <button disabled={busy} onClick={() => {
              if (window.confirm("Leave this payment? If already charged, refund it in the Square app before starting another sale.")) { localStorage.removeItem(manualKey); setManual(null); setPhase("idle"); }
            }}>Back</button>
          </div>
        </div>
      ) : null}

      {discountOpen ? (
        <div className="modal">
          <div className="card grid">
            <h2>Ticket discount %</h2>
            <p className="muted">
              Clerk max {(rewards.clerkMaxDiscountBps / 100).toFixed(0)}%
              {isAdmin ? " (admins may exceed)" : " — above that needs manager PIN"}.
            </p>
            <label>
              Percent
              <input value={discountDraft} onChange={(e) => setDiscountDraft(e.target.value)} inputMode="decimal" autoFocus />
            </label>
            <div className="row">
              <button type="button" onClick={() => setDiscountOpen(false)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={applyDiscountDraft}>
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {noteOpen ? (
        <div className="modal">
          <div className="card grid">
            <h2>Order note</h2>
            <textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
            <div className="row">
              <button type="button" onClick={() => setNoteOpen(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editLine ? (
        <div className="modal">
          <div className="card grid">
            <h2>Edit {editLine.sku}</h2>
            <p className="muted">Ask {formatCents(editLine.askCents) || "—"}</p>
            <label>
              Sale price
              <input
                value={centsToInput(editLine.priceCents)}
                onChange={(e) => {
                  const cents = parseMoneyToCents(e.target.value);
                  if (typeof cents === "number") updateLine(editLine.sku, { priceCents: cents, approvalId: null });
                }}
              />
            </label>
            {editLine.askCents != null && editLine.priceCents !== editLine.askCents ? (
              <label>
                Override reason
                <input
                  value={editLine.overrideReason}
                  onChange={(e) => updateLine(editLine.sku, { overrideReason: e.target.value })}
                  placeholder="Required when price ≠ ask"
                />
              </label>
            ) : null}
            <div className="row">
              <button type="button" className="danger" onClick={() => { removeSku(editLine.sku); setEditSku(null); }}>
                Remove
              </button>
              <button type="button" className="primary" onClick={() => setEditSku(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {splitOpen ? (
        <div className="modal">
          <div className="card grid">
            <h2>Split payment</h2>
            <p className="muted">Total {formatCentsTotal(total)}. Card charges the remainder after cash.</p>
            <label>
              Cash amount
              <input
                value={splitCashDraft}
                onChange={(e) => setSplitCashDraft(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                autoFocus
              />
            </label>
            {typeof parseMoneyToCents(splitCashDraft) === "number" ? (
              <>
                <p className="muted">
                  Card portion{" "}
                  {formatCentsTotal(Math.max(0, total - (parseMoneyToCents(splitCashDraft) as number)))}
                  {cardFeeBps > 0
                    ? ` + card fee ${formatCentsTotal(
                        cardFeeCents(
                          Math.max(0, total - (parseMoneyToCents(splitCashDraft) as number)),
                          cardFeeBps,
                        ),
                      )}`
                    : ""}
                </p>
                <p>
                  Card charge{" "}
                  <strong>
                    {formatCentsTotal(
                      (() => {
                        const base = Math.max(0, total - (parseMoneyToCents(splitCashDraft) as number));
                        return base + cardFeeCents(base, cardFeeBps);
                      })(),
                    )}
                  </strong>
                </p>
              </>
            ) : null}
            <div className="row">
              <button type="button" onClick={() => setSplitOpen(false)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void confirmSplit()}>
                Continue to card amount
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {signupOpen ? (
        <div className="modal">
          <div className="card grid">
            <h2>New customer</h2>
            <p className="muted">Phone {customerPhone}. Name and email only — we never text this number.</p>
            <label>
              Name
              <input value={signupName} onChange={(e) => setSignupName(e.target.value)} autoFocus />
            </label>
            <label>
              Email
              <input value={signupEmail} onChange={(e) => setSignupEmail(e.target.value)} />
            </label>
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input type="checkbox" checked={signupMarketing} onChange={(e) => setSignupMarketing(e.target.checked)} />
              Email store news (optional). We will not text you.
            </label>
            <div className="row">
              <button type="button" onClick={() => setSignupOpen(false)}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void createCustomer()}>
                Save customer
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pinKind ? (
        <div className="modal">
          <div className="card grid">
            <h2>Manager PIN</h2>
            <p className="muted">
              {pinKind === "ticket_discount"
                ? "Discount above clerk maximum."
                : `Below floor on SKU ${pinSku}.`}
            </p>
            <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  setPinKind(null);
                  setPinSku(null);
                  setPendingAction(null);
                }}
              >
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

