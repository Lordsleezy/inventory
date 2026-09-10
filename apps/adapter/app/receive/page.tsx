"use client";

import { useEffect, useRef, useState } from "react";
import { Shell } from "@/components/shell";
import { MoneyField } from "@/components/money-field";

type Hint = { sku: string; brand: string; model: string; title: string; category: string };

const WAREHOUSE = ["Receiving", "Floor", "Back"] as const;

export default function ReceivePage() {
  const brandRef = useRef<HTMLInputElement>(null);
  const [sku, setSku] = useState("");
  const skuTouched = useRef(false);
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [ask, setAsk] = useState("");
  const [msrp, setMsrp] = useState("");
  const [warehouse, setWarehouse] = useState<(typeof WAREHOUSE)[number]>("Receiving");
  const [hint, setHint] = useState<Hint | null>(null);
  const [error, setError] = useState("");
  const [last, setLast] = useState("");
  const [more, setMore] = useState(false);

  useEffect(() => {
    brandRef.current?.focus();
    void refreshSku();
  }, []);

  async function refreshSku() {
    const res = await fetch("/api/units?next=1");
    const data = await res.json();
    if (data.sku && !skuTouched.current) setSku(data.sku);
  }

  async function checkSku(value: string) {
    if (value.length !== 5) return;
    const res = await fetch(`/api/units?checkSku=${value}`);
    const data = await res.json();
    if (!data.ok) setError(data.error ?? "That SKU is already used");
    else setError("");
  }

  async function lookupModel(value: string) {
    if (!value.trim()) {
      setHint(null);
      return;
    }
    const res = await fetch(`/api/units?model=${encodeURIComponent(value.trim())}`);
    const data = await res.json();
    setHint(data.hint ?? null);
  }

  async function submit() {
    setError("");
    if (!ask.trim()) {
      setError("Price is required");
      return;
    }
    const res = await fetch("/api/units", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku, brand, model, title, category, ask, msrp, location: warehouse }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Save failed — form kept");
      return;
    }
    setLast(data.unit.sku);
    setBrand("");
    setModel("");
    setTitle("");
    setCategory("");
    setAsk("");
    setMsrp("");
    setWarehouse("Receiving");
    setHint(null);
    skuTouched.current = false;
    await refreshSku();
    brandRef.current?.focus();
  }

  return (
    <Shell>
      <form
        className="grid max-w-xl gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="grid gap-1">
          <span className="text-quiet text-floor-mute">SKU</span>
          <input
            value={sku}
            onChange={(e) => {
              skuTouched.current = true;
              setSku(e.target.value.replace(/\D/g, "").slice(0, 5));
            }}
            onBlur={() => {
              if (sku.length === 5) void checkSku(sku);
            }}
            inputMode="numeric"
            maxLength={5}
            className="field text-display tracking-widest"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-quiet text-floor-mute">Brand</span>
          <input
            ref={brandRef}
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="field"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-quiet text-floor-mute">Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => void lookupModel(model)}
            className="field"
          />
        </label>
        {hint ? (
          <button
            type="button"
            className="min-h-touch text-left text-body text-floor-mute"
            onClick={() => {
              setBrand(hint.brand);
              setTitle(hint.title);
              setCategory(hint.category);
            }}
          >
            Copy description from {hint.sku}: {hint.brand} {hint.model}
          </button>
        ) : null}
        <label className="grid gap-1">
          <span className="text-quiet text-floor-mute">Description</span>
          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="field min-h-24 py-2"
          />
        </label>
        <MoneyField label="Price" value={ask} onChange={setAsk} />
        <MoneyField label="MSRP" value={msrp} onChange={setMsrp} />
        <div>
          <p className="text-quiet text-floor-mute">Warehouse</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {WAREHOUSE.map((row) => (
              <button
                key={row}
                type="button"
                onClick={() => setWarehouse(row)}
                className={`min-h-touch px-2 text-body ${
                  warehouse === row ? "text-floor-text" : "text-floor-mute"
                }`}
              >
                {row}
              </button>
            ))}
          </div>
        </div>
        <button type="button" onClick={() => setMore((value) => !value)} className="btn-text px-0">
          {more ? "Less" : "More"}
        </button>
        {more ? (
          <label className="grid gap-1">
            <span className="text-quiet text-floor-mute">Category</span>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="field"
            />
          </label>
        ) : null}
        {error ? <p className="text-body text-floor-danger">{error}</p> : null}
        {last ? <p className="text-quiet text-floor-ok">Saved {last}</p> : null}
        <button type="submit" className="btn-accent w-fit" disabled={!ask.trim()}>
          Save and next
        </button>
      </form>
    </Shell>
  );
}
