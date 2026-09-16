"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cannotSellReason, type FloorConfig, type Unit } from "@floor/domain";
import { MoneyField } from "./money-field";
import { SaleReceiptUpload } from "./sale-receipt-upload";

export function QuickSell({ unit, onSold }: { unit: Unit; onSold: (unit: Unit) => void }) {
  const [config, setConfig] = useState<FloorConfig | null>(null);
  const [role, setRole] = useState("staff");
  const [channel, setChannel] = useState("");
  const [proceeds, setProceeds] = useState("");
  const [confirmFloor, setConfirmFloor] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saleId, setSaleId] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const blocked = cannotSellReason(unit);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        setConfig(data.config);
        if (data.role) setRole(data.role);
        const first = (data.config?.channels ?? []).find((row: { enabled: boolean }) => row.enabled);
        if (first) setChannel((current) => current || first.id);
      })
      .catch(() => undefined);
  }, []);

  if (unit.state === "sold" || saleId) {
    const id = saleId ?? (unit.sale?.salesOrderId ? Number(unit.sale.salesOrderId) : null);
    return (
      <section className="mt-8">
        <p className="text-title">Sold</p>
        {id ? (
          <div className="mt-2">
            <SaleReceiptUpload saleId={id} />
            <p className="mt-1">
              <Link href={`/reports?sku=${unit.sku}`} className="inline-flex min-h-touch items-center px-0 text-body text-floor-mute">
                Sales history
              </Link>
            </p>
          </div>
        ) : null}
      </section>
    );
  }

  if (blocked) {
    return (
      <section className="mt-8">
        <p className="text-quiet text-floor-mute">Cannot mark sold — {blocked}</p>
        <Link href="/sell" className="btn-text px-0">
          Open register
        </Link>
      </section>
    );
  }

  const channels = [
    ...(config?.channels ?? []).filter((row) => row.enabled),
    { id: "other", label: "Other", enabled: true },
  ];

  async function sell() {
    setError("");
    setBusy(true);
    const res = await fetch(`/api/units/${unit.sku}/sell`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, proceeds, confirmBelowFloor: confirmFloor }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not mark sold");
      return;
    }
    setSaleId(data.sale?.id ?? null);
    if (data.unit) onSold(data.unit);
  }

  if (!open) {
    return (
      <section className="mt-8">
        <button type="button" onClick={() => setOpen(true)} className="btn-text px-0">
          Mark sold
        </button>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <button type="button" onClick={() => setOpen(false)} className="btn-text px-0">
        Mark sold · hide
      </button>
      <p className="mt-1 text-quiet text-floor-mute">Facebook, eBay, and the rest. In-store stays on Register.</p>
      <div className="mt-3 flex flex-wrap gap-1">
        {channels.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => setChannel(row.id)}
            className={`min-h-touch px-2 text-body ${
              channel === row.id ? "text-floor-accent" : "text-floor-mute"
            }`}
          >
            {row.label}
          </button>
        ))}
      </div>
      <div className="mt-3 max-w-xs">
        <MoneyField label="What you actually got" value={proceeds} onChange={setProceeds} />
      </div>
      {unit.floorCents != null && role === "admin" ? (
        <label className="mt-3 flex min-h-touch items-center gap-2 text-body">
          <input
            type="checkbox"
            checked={confirmFloor}
            onChange={(e) => setConfirmFloor(e.target.checked)}
          />
          Confirm below floor
        </label>
      ) : null}
      {error ? <p className="mt-2 text-body text-floor-danger">{error}</p> : null}
      <button
        type="button"
        disabled={busy || !channel || !proceeds}
        onClick={() => void sell()}
        className="btn-accent mt-3 disabled:opacity-40"
      >
        {busy ? "Saving…" : "Mark sold"}
      </button>
    </section>
  );
}
