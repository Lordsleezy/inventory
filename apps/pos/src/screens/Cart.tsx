import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { centsToInput, formatCents, formatCentsTotal, parseMoneyToCents } from "@floor/store";
import { allocateLineTaxes } from "@floor/cloud";
import { useCart } from "../cart";
import { usePos } from "../pos-context";

export function CartScreen() {
  const { lines, removeSku, updateLine } = useCart();
  const { taxRateBps } = usePos();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  const prices = lines.map((l) => l.priceCents);
  const taxes = useMemo(() => {
    if (taxRateBps == null || !prices.length) return prices.map(() => 0);
    try {
      return allocateLineTaxes(prices, taxRateBps);
    } catch {
      return prices.map(() => 0);
    }
  }, [prices.join(","), taxRateBps]);

  const subtotal = prices.reduce((a, b) => a + b, 0);
  const tax = taxes.reduce((a, b) => a + b, 0);
  const total = subtotal + tax;

  function goTender() {
    setError("");
    if (taxRateBps == null) {
      setError("Set your tax rate in Settings before checkout.");
      return;
    }
    for (const line of lines) {
      if (line.askCents != null && line.priceCents !== line.askCents && !line.overrideReason.trim()) {
        setError(`SKU ${line.sku}: enter a reason when the price differs from ask.`);
        return;
      }
    }
    navigate("/tender");
  }

  if (!lines.length) {
    return (
      <section className="page">
        <p className="muted">Cart is empty.</p>
        <button type="button" onClick={() => navigate("/")}>
          Back to search
        </button>
      </section>
    );
  }

  return (
    <section className="page grid">
      <div className="row">
        <h1>Cart</h1>
        <button type="button" onClick={() => navigate("/")}>
          Add more
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {lines.map((line, i) => (
        <div className="card grid" key={line.sku}>
          <div className="row">
            <strong>
              {line.sku} · {line.title}
            </strong>
            <button type="button" className="danger" onClick={() => removeSku(line.sku)}>
              Remove
            </button>
          </div>
          <p className="muted">{line.condition || ""} · Ask {formatCents(line.askCents) || "—"}</p>
          <label>
            Sale price
            <input
              value={centsToInput(line.priceCents)}
              onChange={(e) => {
                const cents = parseMoneyToCents(e.target.value);
                if (typeof cents === "number") updateLine(line.sku, { priceCents: cents, approvalId: null });
              }}
            />
          </label>
          {line.askCents != null && line.priceCents !== line.askCents ? (
            <label>
              Override reason
              <input
                value={line.overrideReason}
                onChange={(e) => updateLine(line.sku, { overrideReason: e.target.value })}
                placeholder="Required when price ≠ ask"
              />
            </label>
          ) : null}
          <p className="muted">Line tax (est.) {formatCentsTotal(taxes[i] ?? 0)}</p>
        </div>
      ))}
      <div className="card">
        <div className="row">
          <span>Subtotal</span>
          <span>{formatCentsTotal(subtotal)}</span>
        </div>
        <div className="row">
          <span>Tax {taxRateBps != null ? `(${(taxRateBps / 100).toFixed(2)}%)` : ""}</span>
          <span>{formatCentsTotal(tax)}</span>
        </div>
        <div className="row price">
          <span>Total</span>
          <span>{formatCentsTotal(total)}</span>
        </div>
      </div>
      <button type="button" className="primary" onClick={goTender}>
        Continue to payment
      </button>
    </section>
  );
}
