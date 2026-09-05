"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  formatUsd,
  type FloorConfig,
  type FloorSale,
  type Unit,
} from "@floor/domain";
import { Shell } from "@/components/shell";
import { SkuKeypad } from "@/components/sku-keypad";
import { UnitPreview } from "@/components/unit-preview";
import { Money } from "@/components/empty-value";
import { MoneyField } from "@/components/money-field";

function centsField(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2);
}

export default function SellPage() {
  const router = useRouter();
  const [config, setConfig] = useState<FloorConfig | null>(null);
  const [role, setRole] = useState<"admin" | "staff">("staff");
  const [mode, setMode] = useState<"sell" | "return">("sell");
  const [parked, setParked] = useState<FloorSale[]>([]);
  const [sale, setSale] = useState<FloorSale | null>(null);
  const [sku, setSku] = useState("");
  const [unit, setUnit] = useState<Unit | null>(null);
  const [missing, setMissing] = useState(false);
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const [method, setMethod] = useState("");
  const [confirmFloor, setConfirmFloor] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [restock, setRestock] = useState("available");
  const [returnSale, setReturnSale] = useState<FloorSale | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        setConfig(data.config);
        setRole(data.role);
      });
    void refreshParked();
  }, []);

  async function refreshParked() {
    const res = await fetch("/api/sales");
    const data = await res.json();
    if (res.ok) setParked(data.sales ?? []);
  }

  useEffect(() => {
    if (sku.length !== 5) {
      setUnit(null);
      setMissing(false);
      setReturnSale(null);
      return;
    }
    fetch(`/api/units/${sku}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          setUnit(null);
          setMissing(true);
          return;
        }
        const next = data.unit as Unit;
        setMissing(false);
        setUnit(next);
        setPrice(centsField(next.askCents));
      })
      .catch(() => setMissing(true));
  }, [sku]);

  async function api(path: string, body?: Record<string, unknown>) {
    setError("");
    setBusy(true);
    try {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed");
        return null;
      }
      return data;
    } finally {
      setBusy(false);
    }
  }

  async function ensureSale(): Promise<FloorSale | null> {
    if (sale) return sale;
    const data = await api("/api/sales", { name, phone, email });
    if (!data?.sale) return null;
    setSale(data.sale);
    return data.sale as FloorSale;
  }

  async function addSku() {
    const current = await ensureSale();
    if (!current || !unit) return;
    const data = await api(`/api/sales/${current.id}`, {
      op: "add",
      sku: unit.sku,
      price,
      confirmBelowFloor: confirmFloor,
    });
    if (!data?.sale) return;
    setSale(data.sale);
    setSku("");
    setUnit(null);
    setPrice("");
    setConfirmFloor(false);
    await refreshParked();
  }

  async function removeSku(lineSku: string) {
    if (!sale) return;
    const data = await api(`/api/sales/${sale.id}`, { op: "remove", sku: lineSku });
    if (data?.sale) setSale(data.sale);
  }

  async function saveDiscount() {
    if (!sale) return;
    const data = await api(`/api/sales/${sale.id}`, { op: "discount", discount });
    if (data?.sale) setSale(data.sale);
  }

  async function park() {
    if (!sale) return;
    const data = await api(`/api/sales/${sale.id}`, { op: "park" });
    if (!data?.sale) return;
    setSale(null);
    await refreshParked();
  }

  async function complete() {
    if (!sale) return;
    const data = await api(`/api/sales/${sale.id}`, {
      op: "complete",
      paymentMethod: method,
      confirmBelowFloor: confirmFloor,
    });
    if (!data?.sale) return;
    const id = data.sale.id;
    setSale(null);
    setMethod("");
    await refreshParked();
    router.push(`/receipt?sale=${id}`);
  }

  async function cancel() {
    if (!sale) return;
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    const data = await api(`/api/sales/${sale.id}`, { op: "cancel" });
    if (!data?.sale) return;
    setSale(null);
    setConfirmCancel(false);
    await refreshParked();
  }

  async function lookupReturn() {
    if (sku.length !== 5) return;
    const data = await api(`/api/sales?sku=${sku}`);
    if (data?.sale) setReturnSale(data.sale);
  }

  async function submitReturn() {
    if (!returnSale || !sku) return;
    const data = await api(`/api/sales/${returnSale.id}`, {
      op: "return",
      sku,
      restock,
      reason,
    });
    if (!data) return;
    setReason("");
    setSku("");
    setUnit(null);
    setReturnSale(null);
  }

  return (
    <Shell>
      <div className="mb-3 flex gap-2">
        <button
          type="button"
          className={`min-h-touch rounded-lg px-4 font-black uppercase ${mode === "sell" ? "bg-floor-accent text-black" : "border border-floor-line"}`}
          onClick={() => setMode("sell")}
        >
          Sell
        </button>
        <button
          type="button"
          className={`min-h-touch rounded-lg px-4 font-black uppercase ${mode === "return" ? "bg-floor-accent text-black" : "border border-floor-line"}`}
          onClick={() => setMode("return")}
        >
          Return
        </button>
      </div>

      {mode === "return" ? (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <SkuKeypad value={sku} onChange={setSku} onEnter={() => void lookupReturn()} />
          <div className="grid gap-3">
            <UnitPreview unit={unit} missing={missing} />
            {unit && unit.state !== "sold" ? (
              <p className="font-bold text-floor-danger">Not sold — cannot return</p>
            ) : null}
            {returnSale ? (
              <>
                <p className="text-xl font-bold">{returnSale.reference}</p>
                <label className="grid gap-1">
                  <span className="text-sm text-floor-mute">Restock as</span>
                  <select
                    value={restock}
                    onChange={(e) => setRestock(e.target.value)}
                    className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
                  >
                    <option value="available">available</option>
                    <option value="repair">repair</option>
                    <option value="scrapped">scrapped</option>
                  </select>
                </label>
                <label className="grid gap-1">
                  <span className="text-sm text-floor-mute">Reason</span>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void submitReturn()}
                  className="min-h-touch rounded-lg bg-floor-accent text-xl font-black text-black"
                >
                  Return
                </button>
              </>
            ) : (
              <button
                type="button"
                className="min-h-touch rounded-lg border border-floor-line font-bold"
                onClick={() => void lookupReturn()}
              >
                Find sale
              </button>
            )}
            {error ? <p className="font-bold text-floor-danger">{error}</p> : null}
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <div>
            <SkuKeypad value={sku} onChange={setSku} onEnter={() => void addSku()} />
            {parked.length ? (
              <div className="mt-3 grid gap-2">
                <p className="text-sm text-floor-mute">Parked</p>
                {parked.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="min-h-touch rounded-lg border border-floor-line px-3 text-left font-bold"
                    onClick={() => {
                      setSale(row);
                      setDiscount(centsField(row.saleDiscountCents || null));
                      setName(row.customer.name ?? "");
                      setPhone(row.customer.phone ?? "");
                      setEmail(row.customer.email ?? "");
                    }}
                  >
                    {row.reference} · {row.lines.length} item{row.lines.length === 1 ? "" : "s"} ·{" "}
                    {formatUsd(row.totalCents) || "—"}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="grid gap-3">
            <UnitPreview unit={unit} missing={missing} />
            {unit ? (
              <div className="grid gap-3 rounded-xl border border-floor-line bg-floor-panel p-3">
                <MoneyField label="Price" value={price} onChange={setPrice} />
                {role === "admin" ? (
                  <label className="flex min-h-touch items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={confirmFloor}
                      onChange={(e) => setConfirmFloor(e.target.checked)}
                    />
                    Confirm below floor
                  </label>
                ) : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void addSku()}
                  className="min-h-touch rounded-lg bg-floor-accent text-xl font-black text-black"
                >
                  Add to sale
                </button>
              </div>
            ) : null}

            {sale ? (
              <div className="rounded-xl border border-floor-line bg-floor-panel p-3">
                <p className="mb-2 text-xl font-black">{sale.reference}</p>
                <ul className="grid gap-2">
                  {sale.lines.map((line) => (
                    <li key={line.sku} className="flex items-center justify-between gap-2 border-b border-floor-line py-2">
                      <div>
                        <p className="font-black tracking-widest text-floor-accent">{line.sku}</p>
                        <p>{line.title}</p>
                        <p>
                          <Money cents={line.priceCents} />
                        </p>
                      </div>
                      <button
                        type="button"
                        className="min-h-touch rounded-lg border border-floor-danger px-3 font-bold text-floor-danger"
                        onClick={() => void removeSku(line.sku)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 grid gap-2">
                  <MoneyField label="Sale discount" value={discount} onChange={setDiscount} />
                  <button type="button" className="min-h-touch rounded-lg border border-floor-line font-bold" onClick={() => void saveDiscount()}>
                    Apply discount
                  </button>
                  <p>Subtotal: <Money cents={sale.subtotalCents} /></p>
                  <p>Tax: <Money cents={sale.taxCents} /></p>
                  <p className="text-2xl font-black">Total: {formatUsd(sale.totalCents) || ""}</p>
                </div>
                <div className="mt-3 grid gap-2">
                  <input
                    placeholder="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="min-h-touch rounded-lg border border-floor-line bg-black px-3"
                  />
                  <input
                    placeholder="Phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="min-h-touch rounded-lg border border-floor-line bg-black px-3"
                  />
                  <input
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="min-h-touch rounded-lg border border-floor-line bg-black px-3"
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(config?.paymentMethods ?? ["cash", "card", "other"]).map((row) => (
                    <button
                      key={row}
                      type="button"
                      className={`min-h-touch rounded-lg px-4 font-black uppercase ${method === row ? "bg-floor-accent text-black" : "border border-floor-line"}`}
                      onClick={() => setMethod(row)}
                    >
                      {row}
                    </button>
                  ))}
                </div>
                {error ? <p className="mt-2 font-bold text-floor-danger">{error}</p> : null}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button type="button" disabled={busy} onClick={() => void park()} className="min-h-touch rounded-lg border border-floor-line font-bold">
                    Park
                  </button>
                  <button type="button" disabled={busy} onClick={() => void complete()} className="min-h-touch rounded-lg bg-floor-ok font-black text-black">
                    Complete
                  </button>
                  <button type="button" disabled={busy} onClick={() => void cancel()} className="min-h-touch rounded-lg border border-floor-danger font-bold text-floor-danger">
                    {confirmCancel ? "Confirm cancel" : "Cancel"}
                  </button>
                </div>
              </div>
            ) : error ? (
              <p className="font-bold text-floor-danger">{error}</p>
            ) : null}
          </div>
        </div>
      )}
    </Shell>
  );
}
