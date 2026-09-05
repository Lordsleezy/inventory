"use client";

import { useEffect, useRef, useState } from "react";
import { Shell } from "@/components/shell";
import { MoneyField } from "@/components/money-field";

type Hint = { sku: string; brand: string; model: string; title: string; category: string };

export default function ReceivePage() {
  const brandRef = useRef<HTMLInputElement>(null);
  const [lot, setLot] = useState("");
  const [sku, setSku] = useState("");
  const skuTouched = useRef(false);
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [acquisition, setAcquisition] = useState("");
  const [hint, setHint] = useState<Hint | null>(null);
  const [error, setError] = useState("");
  const [last, setLast] = useState("");
  const [role, setRole] = useState("staff");

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        if (data.role) setRole(data.role);
      });
    const saved = sessionStorage.getItem("floor-lot");
    if (saved) setLot(saved);
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
    const res = await fetch("/api/units", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku, brand, model, title, category, lot, acquisition }),
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
    setAcquisition("");
    setHint(null);
    skuTouched.current = false;
    await refreshSku();
    brandRef.current?.focus();
  }

  return (
    <Shell>
      <h1 className="mb-3 text-2xl font-black">Receive</h1>
      <form
        className="grid max-w-xl gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="grid gap-1">
          <span className="text-sm text-floor-mute">Lot (this session)</span>
          <input
            value={lot}
            onChange={(e) => {
              setLot(e.target.value);
              sessionStorage.setItem("floor-lot", e.target.value);
            }}
            className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-sm text-floor-mute">SKU (type any unused 5-digit number, or keep the next one)</span>
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
            className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-5xl font-black tracking-widest text-floor-accent"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-sm text-floor-mute">Brand</span>
          <input
            ref={brandRef}
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-sm text-floor-mute">Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={() => void lookupModel(model)}
            className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
          />
        </label>
        {hint ? (
          <button
            type="button"
            className="min-h-touch rounded-lg border border-floor-accent px-3 text-left font-bold"
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
          <span className="text-sm text-floor-mute">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-sm text-floor-mute">Category</span>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
          />
        </label>
        {role === "admin" ? <MoneyField label="Acquisition cost" value={acquisition} onChange={setAcquisition} adminOnly /> : null}
        {error ? <p className="font-bold text-floor-danger">{error}</p> : null}
        {last ? <p className="text-floor-ok">Saved {last}</p> : null}
        <button type="submit" className="min-h-touch rounded-lg bg-floor-accent text-xl font-black text-black">
          Save and next
        </button>
      </form>
    </Shell>
  );
}
