import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { centsToInput, formatCents, formatCentsTotal, loadUnit, parseMoneyToCents, type Unit } from "@floor/store";
import { finalizeSale, releaseReservation, reserveUnit, SellError } from "@floor/cloud";
import { cashProvider } from "@floor/payments";
import { FloorSquare } from "@floor/square-plugin";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";
import { askManagerPin } from "../pin";
import { friendlyRpc } from "../rpc";
import { authHeader, functionsUrl } from "../functions";

export function CheckoutScreen() {
  const { sku = "" } = useParams();
  const navigate = useNavigate();
  const { db, settings, online, cardPayments, ensureOnline, hydrate } = useStore();
  const [unit, setUnit] = useState<Unit | null>(null);
  const [channel, setChannel] = useState("floor");
  const [price, setPrice] = useState("");
  const [elsewhere, setElsewhere] = useState(false);
  const [error, setError] = useState("");
  const [loud, setLoud] = useState("");
  const [busy, setBusy] = useState(false);
  const [holdUntil, setHoldUntil] = useState<number | null>(null);
  const [reservationId, setReservationId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    void loadUnit(db, sku).then((found) => {
      setUnit(found ?? null);
      if (found) setPrice(centsToInput(found.askCents));
    });
  }, [db, sku]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const cents = parseMoneyToCents(price);
  const tax =
    typeof cents === "number" ? Math.round((cents * settings.taxRateBps) / 10_000) : 0;
  const total = typeof cents === "number" ? cents + tax : 0;
  // Client preview only — finalize_sale recomputes the fee server-side.
  const cardFee = Math.round((total * (settings.cardFeeBps || 0)) / 10_000);
  const cardTotal = total + cardFee;
  const remain = holdUntil ? Math.max(0, Math.ceil((holdUntil - now) / 1000)) : 0;

  async function startHold() {
    const reserved = await reserveUnit(sku, elsewhere ? channel : "floor");
    setReservationId(reserved.id);
    setHoldUntil(new Date(reserved.expires_at).getTime());
    return reserved.id;
  }

  async function finish(method: string, paymentId: string | null) {
    await ensureOnline();
    if (cents == null || cents === undefined) throw new Error("Enter the price.");
    let approvalId: string | null = null;
    let hold = reservationId;
    if (!hold) hold = await startHold();
    try {
      await finalizeSale({
        sku,
        channel: elsewhere ? channel : "floor",
        priceCents: cents,
        paymentMethod: method,
        paymentId,
        reservationId: hold,
        taxCents: tax,
        approvalId,
      });
    } catch (err) {
      if (err instanceof SellError && err.code === "below_floor") {
        approvalId = await askManagerPin("below_floor", sku);
        await finalizeSale({
          sku,
          channel: elsewhere ? channel : "floor",
          priceCents: cents,
          paymentMethod: method,
          paymentId,
          reservationId: hold,
          taxCents: tax,
          approvalId,
        });
      } else {
        throw err;
      }
    }
    try {
      await hydrate();
    } catch {
      // Sale is already saved in the cloud; the next successful hydrate will catch up.
    }
    try {
      const { authHeader, functionsUrl } = await import("../functions");
      const headers = await authHeader();
      await fetch(functionsUrl("ebay-withdraw"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ afterSale: true, sku }),
      });
    } catch {
      /* ebay-sync will end the listing within 5 minutes */
    }
    navigate("/inventory", { replace: true, state: { filter: "sold" } });
  }

  async function payCash() {
    setError("");
    setLoud("");
    setBusy(true);
    try {
      await ensureOnline();
      const charged = await cashProvider.charge({ amountCents: total, currency: "USD" });
      if (!charged.ok) throw new Error("Cash charge failed");
      await finish("cash", charged.paymentId);
    } catch (err) {
      if (err instanceof SellError && err.code === "double_sell") setLoud(err.message);
      else setError(friendlyRpc(err));
      if (reservationId) await releaseReservation(reservationId);
      setReservationId(null);
    } finally {
      setBusy(false);
    }
  }

  async function payCard() {
    setError("");
    setLoud("");
    setBusy(true);
    try {
      await ensureOnline();
      const headers = await authHeader();
      const authRes = await fetch(functionsUrl("square-mobile-auth"), { headers });
      const authBody = await authRes.json().catch(() => ({}));
      if (!authRes.ok) {
        if (authBody.error === "square_not_connected") {
          throw new Error("Square is not connected. On the register: Settings → Connect Square, then pick a location.");
        }
        if (authBody.error === "square_location_required") {
          throw new Error("Square is connected but no location is picked. On the register: Settings → List locations → pick one.");
        }
        throw new Error(
          authBody.message || `Square auth failed (HTTP ${authRes.status}): ${authBody.error || "unknown"}`,
        );
      }
      const authorized = await FloorSquare.authorize({
        accessToken: authBody.accessToken,
        locationId: authBody.locationId,
        mock: false,
      });
      if (!authorized.ok) {
        setError(authorized.reason || "Could not authorize Square reader.");
        return;
      }
      const charged = await FloorSquare.charge({ amountCents: cardTotal, mock: false });
      if (!charged.ok || !charged.paymentId) {
        setError(charged.reason === "canceled" ? "Card canceled." : charged.reason || "Card declined.");
        if (reservationId) await releaseReservation(reservationId);
        setReservationId(null);
        return;
      }
      try {
        await finish("card", charged.paymentId);
      } catch (err) {
        // Card was charged but the sale did not record — refund in full.
        try {
          const headers = await authHeader();
          await fetch(functionsUrl("square-refund-payment"), {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              paymentId: charged.paymentId,
              amountCents: cardTotal,
              reason: "phone_finalize_failed",
            }),
          });
          setLoud(
            `Card was charged but the sale could not be recorded (${friendlyRpc(err)}). The payment was refunded.`,
          );
        } catch {
          setLoud(
            `Card was charged but the sale failed and the automatic refund did not go through. Refund payment ${charged.paymentId} in Square Dashboard. (${friendlyRpc(err)})`,
          );
        }
        if (reservationId) await releaseReservation(reservationId);
        setReservationId(null);
        return;
      }
    } catch (err) {
      if (err instanceof SellError && err.code === "double_sell") setLoud(err.message);
      else setError(friendlyRpc(err));
      if (reservationId) await releaseReservation(reservationId);
      setReservationId(null);
    } finally {
      setBusy(false);
    }
  }

  if (!unit) return <p className="text-quiet">No unit.</p>;

  return (
    <section>
      <h1 className="text-title">Checkout {unit.sku}</h1>
      {loud ? <p className="mt-3 border border-floor-danger p-3 text-body text-floor-danger">{loud}</p> : null}
      <Notice tone="error">{error}</Notice>
      {!online ? <Notice tone="error">Connect to the internet to sell.</Notice> : null}

      <label className="mt-3 flex items-center gap-2">
        <input type="checkbox" checked={elsewhere} onChange={(e) => setElsewhere(e.target.checked)} />
        <span className="text-body">Sold on another channel</span>
      </label>

      {elsewhere ? (
        <label className="block py-2">
          <Label>Channel</Label>
          <select className="field mt-1" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {settings.channels.filter((c) => c !== "floor").map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="block py-2">
        <Label>Price</Label>
        <input className="field mt-1" value={price} inputMode="decimal" onChange={(e) => setPrice(e.target.value)} />
      </label>
      <p className="text-quiet text-floor-mute">
        Tax {formatCents(tax) || "$0.00"} · Total {formatCentsTotal(total)}
        {remain ? ` · hold ${remain}s` : ""}
      </p>
      {cardFee > 0 ? (
        <p className="text-quiet text-floor-mute">
          Card fee {formatCents(cardFee)} · Card total {formatCentsTotal(cardTotal)}
        </p>
      ) : null}

      {!elsewhere ? (
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" className="btn-accent" disabled={busy || !online} onClick={() => void payCash()}>
            Cash
          </button>
          <div className="border border-floor-line p-3">
            <p className="text-quiet">
              Card via Square Mobile Payments SDK
              {cardPayments ? "" : " (mock reader until Square is connected)"}
            </p>
            <button type="button" className="btn-accent mt-2" disabled={busy || !online} onClick={() => void payCard()}>
              Charge card
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn-accent mt-4" disabled={busy || !online} onClick={() => void finish("external", `ext_${Date.now()}`).catch((err) => {
          if (err instanceof SellError && err.code === "double_sell") setLoud(err.message);
          else setError(friendlyRpc(err));
        })}>
          Record sale
        </button>
      )}
    </section>
  );
}
