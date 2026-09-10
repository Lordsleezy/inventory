import { cannotSellReason, type FloorConfig, type Unit } from "@floor/domain";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiJson } from "../api";
import { ReceiptUpload } from "./Receipt";

export function MarkSold({ unit, onSold }: { unit: Unit; onSold: (unit: Unit) => void }) {
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
    void apiJson<{ config?: FloorConfig; role?: string }>("/api/config").then(({ data }) => {
      setConfig(data.config ?? null);
      if (data.role) setRole(data.role);
      const first = (data.config?.channels ?? []).find((row) => row.enabled);
      if (first) setChannel((current) => current || first.id);
    });
  }, []);

  if (unit.state === "sold" || saleId) {
    const id = saleId ?? (unit.sale?.salesOrderId ? Number(unit.sale.salesOrderId) : null);
    return (
      <section className="mt-8">
        <p className="text-title">Sold</p>
        {id ? (
          <div className="mt-2">
            <ReceiptUpload saleId={id} />
            <p className="mt-1">
              <Link to={`/reports?sku=${unit.sku}`} className="btn-text px-0">
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
    const { ok, data } = await apiJson<{ error?: string; sale?: { id?: number }; unit?: Unit }>(
      `/api/units/${unit.sku}/sell`,
      {
        method: "POST",
        body: JSON.stringify({ channel, proceeds, confirmBelowFloor: confirmFloor }),
      },
    );
    setBusy(false);
    if (!ok) {
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
      <div className="mt-3 flex flex-wrap gap-1">
        {channels.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => setChannel(row.id)}
            className={`min-h-touch px-2 text-body ${channel === row.id ? "text-floor-accent" : "text-floor-mute"}`}
          >
            {row.label}
          </button>
        ))}
      </div>
      <label className="mt-3 block text-quiet text-floor-mute">
        What you actually got
        <input
          value={proceeds}
          onChange={(e) => setProceeds(e.target.value)}
          inputMode="decimal"
          className="field mt-1"
        />
      </label>
      {unit.floorCents != null && role === "admin" ? (
        <label className="mt-3 flex min-h-touch items-center gap-2 text-body">
          <input type="checkbox" checked={confirmFloor} onChange={(e) => setConfirmFloor(e.target.checked)} />
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
