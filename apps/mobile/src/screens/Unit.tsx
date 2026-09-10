import { displayAskCents, formatUsd, type FloorConfig, type Unit } from "@floor/domain";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { apiJson } from "../api";
import { MarkSold } from "../components/MarkSold";
import { Photos } from "../components/Photos";
import { Shell } from "../components/Shell";

function centsToField(cents: number | null): string {
  if (cents === null || cents === 0) return "";
  return (cents / 100).toFixed(2);
}

export function UnitScreen() {
  const { sku } = useParams<{ sku: string }>();
  const navigate = useNavigate();
  const [unit, setUnit] = useState<Unit | null>(null);
  const [error, setError] = useState("");
  const onUnit = useCallback((next: Unit) => setUnit(next), []);

  useEffect(() => {
    if (!sku) return;
    void apiJson<{ unit?: Unit; error?: string }>(`/api/units/${sku}`).then(({ ok, status, data }) => {
      if (status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      if (!ok || !data.unit) {
        setError(data.error ?? "Not found");
        setUnit(null);
        return;
      }
      setError("");
      setUnit(data.unit);
    });
  }, [sku, navigate]);

  const identity = unit ? unit.title || [unit.brand, unit.model].filter(Boolean).join(" ") : "";
  const price = unit ? displayAskCents(unit) : null;

  return (
    <Shell>
      <Link to="/inventory" className="btn-text px-0">
        Inventory
      </Link>
      {error ? <p className="mt-4 text-title text-floor-danger">{error}</p> : null}
      {unit ? (
        <article className="mt-3">
          {unit.recordError ? <p className="mb-3 text-body text-floor-danger">{unit.recordError}</p> : null}
          <p className="text-quiet tabular-nums tracking-wide text-floor-mute">{unit.sku}</p>
          <p className="mt-1 text-title">
            {identity || "—"}
            {price ? <span className="text-floor-mute"> {formatUsd(price)}</span> : null}
          </p>
          <p className="mt-1 text-quiet text-floor-mute">
            {unit.state}
            {unit.condition ? ` · ${unit.condition}` : ""}
          </p>
          <Photos sku={unit.sku} unit={unit} onUnit={onUnit} />
          <UnitEditor unit={unit} onSaved={onUnit} />
          <MarkSold unit={unit} onSold={onUnit} />
        </article>
      ) : null}
    </Shell>
  );
}

function UnitEditor({ unit, onSaved }: { unit: Unit; onSaved: (unit: Unit) => void }) {
  const [config, setConfig] = useState<FloorConfig | null>(null);
  const [brand, setBrand] = useState(unit.brand);
  const [model, setModel] = useState(unit.model);
  const [title, setTitle] = useState(unit.title);
  const [condition, setCondition] = useState(unit.condition ?? "");
  const [ask, setAsk] = useState(centsToField(displayAskCents(unit)));
  const [msrp, setMsrp] = useState(centsToField(unit.msrpCents));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    void apiJson<{ config?: FloorConfig }>("/api/config").then(({ data }) => setConfig(data.config ?? null));
  }, []);

  useEffect(() => {
    setBrand(unit.brand);
    setModel(unit.model);
    setTitle(unit.title);
    setCondition(unit.condition ?? "");
    setAsk(centsToField(displayAskCents(unit)));
    setMsrp(centsToField(unit.msrpCents));
  }, [unit]);

  async function patch(body: Record<string, unknown>) {
    setError("");
    const { ok, data } = await apiJson<{ unit?: Unit; error?: string }>(`/api/units/${unit.sku}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (!ok || !data.unit) {
      setError(data.error ?? "Save failed — form kept");
      return;
    }
    onSaved(data.unit);
    setSaved("Saved");
  }

  const conditions = config?.conditions ?? [];

  return (
    <section className="mt-6">
      <label className="block text-quiet text-floor-mute">
        Brand
        <input value={brand} onChange={(e) => setBrand(e.target.value)} className="field mt-1" />
      </label>
      <label className="mt-3 block text-quiet text-floor-mute">
        Model
        <input value={model} onChange={(e) => setModel(e.target.value)} className="field mt-1" />
      </label>
      <label className="mt-3 block text-quiet text-floor-mute">
        Description
        <textarea value={title} onChange={(e) => setTitle(e.target.value)} rows={3} className="field mt-1" />
      </label>
      <div className="mt-3">
        <p className="text-quiet text-floor-mute">Condition</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {conditions.map((row) => (
            <button
              key={row}
              type="button"
              onClick={() => setCondition(row)}
              className={`min-h-touch px-2 text-body ${condition === row ? "text-floor-text" : "text-floor-mute"}`}
            >
              {row}
            </button>
          ))}
        </div>
      </div>
      <label className="mt-3 block text-quiet text-floor-mute">
        Price
        <input value={ask} onChange={(e) => setAsk(e.target.value)} inputMode="decimal" className="field mt-1" />
      </label>
      <label className="mt-3 block text-quiet text-floor-mute">
        MSRP
        <input value={msrp} onChange={(e) => setMsrp(e.target.value)} inputMode="decimal" className="field mt-1" />
      </label>
      {error ? <p className="mt-2 text-body text-floor-danger">{error}</p> : null}
      {saved ? <p className="mt-2 text-quiet text-floor-mute">{saved}</p> : null}
      <button
        type="button"
        className="btn-text mt-2 px-0"
        onClick={() => {
          void (async () => {
            await patch({
              op: "part",
              brand,
              model,
              title,
              category: unit.category,
              upc: unit.upc,
            });
            await patch({
              op: "inspect",
              condition,
              testStatus: unit.testStatus || "untested",
              defectNotes: unit.defectNotes,
              mfrSerial: unit.mfrSerial,
            });
            await patch({
              op: "price",
              ask,
              msrp,
              retail: unit.retail.cents != null ? (unit.retail.cents / 100).toFixed(2) : "",
              retailer: unit.retail.retailer,
              capturedOn: unit.retail.capturedOn,
              floor: unit.floorCents != null ? (unit.floorCents / 100).toFixed(2) : "",
            });
          })();
        }}
      >
        Save
      </button>
    </section>
  );
}
