import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  buildReceipt,
  centsToInput,
  formatCents,
  formatCentsTotal,
  loadUnit,
  parseMoneyToCents,
  receiptHtml,
  saleForSku,
  type Unit,
} from "@floor/store";
import { finalizeSale, releaseReservation, reserveUnit, SellError } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";
import { askManagerPin } from "../pin";
import { friendlyRpc } from "../rpc";
import { openHtml } from "../files";

const moneyEntry = /^\d*(?:\.\d{0,2})?$/;

export function CheckoutScreen() {
  const { sku = "" } = useParams();
  const navigate = useNavigate();
  const { db, settings, online, ensureOnline, hydrate } = useStore();
  const [unit, setUnit] = useState<Unit | null>(null);
  const [channel, setChannel] = useState("facebook");
  const [price, setPrice] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("external");
  const [error, setError] = useState("");
  const [loud, setLoud] = useState("");
  const [busy, setBusy] = useState(false);

  const channels = settings.channels.filter((c) => c !== "floor");
  if (!channels.includes("facebook")) channels.unshift("facebook");
  if (!channels.includes("floor")) channels.push("floor");

  useEffect(() => {
    void loadUnit(db, sku).then((found) => {
      setUnit(found ?? null);
      if (found) setPrice(centsToInput(found.askCents));
    });
  }, [db, sku]);

  const cents = parseMoneyToCents(price);
  const tax = typeof cents === "number" ? Math.round((cents * settings.taxRateBps) / 10_000) : 0;
  const cardFee = paymentMethod === "card" ? Math.round(((cents ?? 0) + tax) * settings.cardFeeBps / 10_000) : 0;
  const total = typeof cents === "number" ? cents + tax + cardFee : 0;

  async function recordSale() {
    setError("");
    setLoud("");
    setBusy(true);
    let hold: string | null = null;
    try {
      await ensureOnline();
      if (cents == null) throw new Error("Enter the price.");
      const reserved = await reserveUnit(sku, channel);
      hold = reserved.id;
      const run = (approvalId: string | null) =>
        finalizeSale({
          sku,
          channel,
          priceCents: cents,
          paymentMethod,
          paymentId: `manual_${Date.now()}`,
          reservationId: hold,
          taxCents: tax,
          approvalId,
        });
      try {
        await run(null);
      } catch (err) {
        if (err instanceof SellError && err.code === "below_floor") {
          const approvalId = await askManagerPin("below_floor", sku);
          await run(approvalId);
        } else {
          throw err;
        }
      }
      try {
        await hydrate();
      } catch {
        /* sale is in the cloud */
      }
      const sale = await saleForSku(db, sku);
      if (sale && unit) {
        const receipt = buildReceipt(sale, unit, settings);
        await openHtml(`receipt-${receipt.receiptNo}.html`, receiptHtml(receipt));
      }
      navigate(`/inventory/${sku}`, { replace: true });
    } catch (err) {
      if (err instanceof SellError && err.code === "double_sell") setLoud(err.message);
      else setError(friendlyRpc(err));
      if (hold) await releaseReservation(hold);
    } finally {
      setBusy(false);
    }
  }

  if (!unit) return <p className="text-quiet">No unit.</p>;

  return (
    <section>
      <h1 className="text-title">Sell {unit.sku}</h1>
      {loud ? <p className="mt-3 border border-floor-danger p-3 text-body text-floor-danger">{loud}</p> : null}
      <Notice tone="error">{error}</Notice>
      {!online ? <Notice tone="error">Connect to the internet to sell.</Notice> : null}

      <p className="mt-3 text-quiet text-floor-mute">
        Manual sale for Facebook, cash, or when the card reader is down. Charge the card in the
        Square app, then record it here.
      </p>

      <label className="block py-2">
        <Label>Where it sold</Label>
        <select className="field mt-1" value={channel} onChange={(e) => setChannel(e.target.value)}>
          {channels.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <label className="block py-2">
        <Label>Sale price before tax</Label>
        <input className="field mt-1" type="text" value={price} inputMode="decimal"
          onChange={(e) => { if (moneyEntry.test(e.target.value)) setPrice(e.target.value); }}
          onBlur={() => { if (price === ".") setPrice(""); else if (price) setPrice(Number(price).toFixed(2)); }} />
      </label>
      {unit.askCents != null && cents != null && cents !== unit.askCents ?
        <p className="text-quiet text-floor-mute">Original price {formatCentsTotal(unit.askCents)} → {formatCentsTotal(cents)}</p> : null}
      <label className="block py-2"><Label>Payment type</Label>
        <select className="field mt-1" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
          <option value="external">Other already paid</option><option value="cash">Cash</option><option value="card">Card</option>
        </select>
      </label>
      <p className="text-quiet text-floor-mute">
        Tax {formatCents(tax) || "$0.00"} · Card fee {formatCentsTotal(cardFee)} · Total {formatCentsTotal(total)}
      </p>

      <button type="button" className="btn-accent mt-4" disabled={busy || !online} onClick={() => void recordSale()}>
        {busy ? "Recording…" : "Record sale and receipt"}
      </button>
    </section>
  );
}
