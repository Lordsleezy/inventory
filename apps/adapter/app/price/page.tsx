"use client";

import { useEffect, useState } from "react";
import { discountOffRetail, isRetailStale, type FloorConfig, type Unit } from "@floor/domain";
import { Shell } from "@/components/shell";
import { SkuKeypad } from "@/components/sku-keypad";
import { UnitPreview } from "@/components/unit-preview";
import { EmptyValue, Money } from "@/components/empty-value";
import { MoneyField } from "@/components/money-field";

function centsToField(cents: number | null): string {
  if (cents === null) return "";
  return (cents / 100).toFixed(2);
}

export default function PricePage() {
  const [config, setConfig] = useState<FloorConfig | null>(null);
  const [role, setRole] = useState("staff");
  const [sku, setSku] = useState("");
  const [unit, setUnit] = useState<Unit | null>(null);
  const [missing, setMissing] = useState(false);
  const [msrp, setMsrp] = useState("");
  const [retail, setRetail] = useState("");
  const [retailer, setRetailer] = useState("");
  const [capturedOn, setCapturedOn] = useState("");
  const [ask, setAsk] = useState("");
  const [floor, setFloor] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => {
        setConfig(data.config);
        setRole(data.role);
      });
  }, []);

  useEffect(() => {
    if (sku.length !== 5) {
      setUnit(null);
      setMissing(false);
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
        setMsrp(centsToField(next.msrpCents));
        setRetail(centsToField(next.retail.cents));
        setRetailer(next.retail.retailer ?? "");
        setCapturedOn(next.retail.capturedOn ?? "");
        setAsk(centsToField(next.askCents));
        setFloor(centsToField(next.floorCents));
      })
      .catch(() => setMissing(true));
  }, [sku]);

  const askCents = ask === "" ? null : Math.round(Number(ask) * 100);
  const retailCents = retail === "" ? null : Math.round(Number(retail) * 100);
  const off = discountOffRetail(Number.isFinite(askCents) ? askCents : null, Number.isFinite(retailCents) ? retailCents : null);
  const stale = isRetailStale(capturedOn || null, config?.retailStaleDays ?? 60);

  async function save() {
    if (!unit) return;
    setError("");
    const res = await fetch(`/api/units/${unit.sku}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "price", msrp, retail, retailer, capturedOn, ask, floor }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Save failed — form kept");
      return;
    }
    setSaved(unit.sku);
    setSku("");
    setUnit(null);
  }

  return (
    <Shell>
      <h1 className="mb-3 text-2xl font-black">Price</h1>
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <SkuKeypad value={sku} onChange={setSku} onEnter={() => void save()} />
        <div>
          <UnitPreview unit={unit} missing={missing} />
          {unit ? (
            <form
              className="mt-3 grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <p className="text-lg">
                Condition: <EmptyValue>{unit.condition}</EmptyValue>
              </p>
              <MoneyField label="MSRP" value={msrp} onChange={setMsrp} />
              <MoneyField label="Retail reference" value={retail} onChange={setRetail} />
              <label className="grid gap-1">
                <span className="text-sm text-floor-mute">Retailer</span>
                <input
                  value={retailer}
                  onChange={(e) => setRetailer(e.target.value)}
                  className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
                />
              </label>
              <label className="grid gap-1">
                <span className="text-sm text-floor-mute">Captured</span>
                <input
                  type="date"
                  value={capturedOn}
                  onChange={(e) => setCapturedOn(e.target.value)}
                  className="min-h-touch rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
                />
              </label>
              {stale ? <p className="font-black text-floor-danger">Retail reference is stale (over 60 days)</p> : null}
              <MoneyField label="Ask" value={ask} onChange={setAsk} />
              {role === "admin" ? <MoneyField label="Floor" value={floor} onChange={setFloor} adminOnly /> : null}
              <p className="text-xl font-bold">{off === null ? <EmptyValue /> : `${off}% off retail`}</p>
              <p>
                Current ask: <Money cents={unit.askCents} />
              </p>
              {error ? <p className="font-bold text-floor-danger">{error}</p> : null}
              {saved ? <p className="text-floor-ok">Saved {saved}</p> : null}
              <button type="submit" className="min-h-touch rounded-lg bg-floor-accent text-xl font-black text-black">
                Save and next SKU
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}
