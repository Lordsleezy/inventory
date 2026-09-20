import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { centsToInput, formatCentsTotal, parseMoneyToCents } from "@floor/store";
import { authErrorMessage, finalizeSale, mapSellError, releaseReservation, reserveUnit, SellError } from "@floor/cloud";
import { usePos } from "../pos-context";
import { outboxInsert, searchUnits, type CachedUnit } from "../local";
import { printReceipt } from "../print-receipt";
import { type ReceiptPayload } from "../receipt";
import { callFunction } from "../functions";
import {
  finalizeCapturedCharge,
  loadPairedReader,
  readerIsFresh,
  sendCharge,
} from "../card-device";

export function CheckoutScreen() {
  const { sku = "" } = useParams();
  const navigate = useNavigate();
  const { online, settings, session, refreshUnits, syncOutbox } = usePos();
  const [unit, setUnit] = useState<CachedUnit | null>(null);
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loud, setLoud] = useState("");
  const [offlineAck, setOfflineAck] = useState(false);
  const [warn, setWarn] = useState(false);
  const [cardStatus, setCardStatus] = useState("");
  const [readerOk, setReaderOk] = useState(false);

  useEffect(() => {
    void searchUnits(sku).then((rows) => {
      const found = rows.find((r) => r.sku === sku) ?? null;
      setUnit(found);
      if (found) setPrice(centsToInput(found.askCents));
    });
  }, [sku]);

  useEffect(() => {
    let stop = false;
    async function tick() {
      const reader = await loadPairedReader().catch(() => null);
      if (!stop) setReaderOk(Boolean(reader && readerIsFresh(reader.lastSeen)));
    }
    void tick();
    const t = setInterval(() => void tick(), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const cents = parseMoneyToCents(price);
  const tax = typeof cents === "number" ? Math.round((cents * settings.taxRateBps) / 10_000) : 0;
  const total = typeof cents === "number" ? cents + tax : 0;
  const cardReady = online && readerOk;
  const title = unit ? [unit.brand, unit.model].filter(Boolean).join(" ") || unit.title : "";

  async function printPayload(payload: ReceiptPayload) {
    await printReceipt(payload, settings);
  }

  async function afterSale(skuSold: string) {
    try {
      await callFunction("ebay-withdraw", {
        method: "POST",
        body: JSON.stringify({ afterSale: true, sku: skuSold }),
      });
    } catch {
      /* ebay-sync will catch up */
    }
    try {
      await refreshUnits();
    } catch {
      /* next online refresh */
    }
  }

  async function payCash(opts: { acknowledged?: boolean } = {}) {
    setError("");
    setLoud("");
    if (cents == null) {
      setError("Enter the price.");
      return;
    }
    if (!online) {
      if (!(opts.acknowledged || offlineAck)) {
        setWarn(true);
        return;
      }
      setBusy(true);
      try {
        const clientSaleId = crypto.randomUUID();
        const holdNo = `HOLD-${clientSaleId.slice(0, 8).toUpperCase()}`;
        const payload: ReceiptPayload = {
          receiptNo: holdNo,
          provisional: true,
          soldAt: new Date().toLocaleString(),
          clerkName: session.displayName,
          sku,
          title,
          condition: unit?.condition ?? null,
          priceCents: cents,
          taxCents: tax,
          totalCents: total,
          tender: "CASH (OFFLINE HOLD)",
          reviewUrl: settings.reviewUrl || null,
        };
        await outboxInsert({
          id: clientSaleId,
          sku,
          priceCents: cents,
          taxCents: tax,
          actorId: session.userId,
          clientSaleId,
          createdAt: new Date().toISOString(),
          receiptPayload: JSON.stringify(payload),
          status: "pending",
          receiptNo: holdNo,
          error: null,
        });
        await printPayload(payload);
        navigate("/", { replace: true });
      } catch (err) {
        setError(authErrorMessage(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    let hold: string | null = null;
    try {
      const reserved = await reserveUnit(sku, "floor");
      hold = reserved.id;
      const sale = (await finalizeSale({
        sku,
        channel: "floor",
        priceCents: cents,
        paymentMethod: "cash",
        paymentId: null,
        reservationId: hold,
        taxCents: tax,
      })) as { receipt_no?: string };
      const receiptNo = sale?.receipt_no || "SALE";
      await printPayload({
        receiptNo,
        soldAt: new Date().toLocaleString(),
        clerkName: session.displayName,
        sku,
        title,
        condition: unit?.condition ?? null,
        priceCents: cents,
        taxCents: tax,
        totalCents: total,
        tender: "CASH",
        reviewUrl: settings.reviewUrl || null,
      });
      await afterSale(sku);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof SellError && err.code === "double_sell") setLoud(err.message);
      else setError(authErrorMessage(err));
      if (hold) await releaseReservation(hold);
    } finally {
      setBusy(false);
    }
  }

  async function payCard() {
    setError("");
    setLoud("");
    setCardStatus("");
    if (!online) {
      setError("Card is disabled offline. Cash only.");
      return;
    }
    if (!readerOk) {
      setError("Wake the reader phone and pair it in Settings.");
      return;
    }
    if (cents == null) {
      setError("Enter the price.");
      return;
    }
    setBusy(true);
    let hold: string | null = null;
    try {
      const reserved = await reserveUnit(sku, "floor");
      hold = reserved.id;
      setCardStatus("Waiting for the phone reader…");
      const charged = await sendCharge("phone_reader", {
        reservationId: hold,
        amountCents: total,
        taxCents: tax,
        sku,
        title,
        actorId: session.userId,
      });
      if (!charged.ok) {
        setError(
          charged.reason === "not_paired"
            ? "Wake the reader phone."
            : charged.reason === "declined"
              ? "Card declined."
              : charged.reason === "canceled"
                ? "Charge canceled."
                : "Card timed out.",
        );
        if (hold) await releaseReservation(hold);
        return;
      }
      let sale: { receipt_no?: string };
      try {
        sale = (await finalizeCapturedCharge(charged.chargeId)) as { receipt_no?: string };
      } catch (err) {
        const mapped = err instanceof SellError ? err : mapSellError(err as { message?: string });
        if (mapped.code === "double_sell") {
          await callFunction("square-refund", {
            method: "POST",
            body: JSON.stringify({ paymentId: charged.paymentId, sku, chargeId: charged.chargeId }),
          });
          setLoud("INCIDENT — card was charged but this SKU is not ours. Refund sent. Do not retry.");
          return;
        }
        throw err;
      }
      await printPayload({
        receiptNo: sale?.receipt_no || "SALE",
        soldAt: new Date().toLocaleString(),
        clerkName: session.displayName,
        sku,
        title,
        condition: unit?.condition ?? null,
        priceCents: cents,
        taxCents: tax,
        totalCents: total,
        tender: "CARD",
        reviewUrl: settings.reviewUrl || null,
      });
      await afterSale(sku);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof SellError && err.code === "double_sell") setLoud(err.message);
      else setError(authErrorMessage(err));
      if (hold) await releaseReservation(hold);
    } finally {
      setBusy(false);
      setCardStatus("");
    }
  }

  return (
    <section className="page">
      {warn ? (
        <div className="modal">
          <div className="card">
            <h2>Offline cash risk</h2>
            <p>
              This SKU might already be sold on eBay or the phone. If sync fails, you owe the customer a refund (or eat
              the cash / recover the unit).
            </p>
            <div className="row">
              <button type="button" onClick={() => setWarn(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setOfflineAck(true);
                  setWarn(false);
                  void payCash({ acknowledged: true });
                }}
              >
                I understand
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <button type="button" onClick={() => navigate("/")}>
        Back
      </button>
      <h1>SKU {sku}</h1>
      <p>{title || "Item"}</p>
      <p className="muted">{unit?.condition || ""}</p>
      {loud ? <div className="incident">{loud}</div> : null}
      {error ? <p className="error">{error}</p> : null}
      {cardStatus ? <p>{cardStatus}</p> : null}
      <label>
        Price
        <input value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <p className="price">{typeof cents === "number" ? formatCentsTotal(total) : "—"}</p>
      <p className="muted">
        Tax {settings.taxRateBps / 100}% · {typeof cents === "number" ? formatCentsTotal(tax) : "$0.00"}
      </p>
      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="button" className="primary" disabled={busy} onClick={() => void payCash()}>
          Cash
        </button>
        <button type="button" disabled={busy || !cardReady} onClick={() => void payCard()}>
          Card{!cardReady ? " (needs paired phone + online)" : ""}
        </button>
      </div>
      <p className="muted">The phone is the card reader. Card never queues offline.</p>
      <button type="button" className="muted" disabled={!online} onClick={() => void syncOutbox()}>
        Sync offline cash
      </button>
    </section>
  );
}

