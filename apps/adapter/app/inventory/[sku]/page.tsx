"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  discountOffRetail,
  displayAskCents,
  formatUsd,
  isRetailStale,
  type FloorConfig,
  type Unit,
} from "@floor/domain";
import { Shell } from "@/components/shell";
import { UnitPhotos } from "@/components/unit-photos";
import { QuickSell } from "@/components/quick-sell";
import { EmptyValue } from "@/components/empty-value";

function Row({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div
      className={`grid grid-cols-[6.5rem_1fr] gap-3 border-b border-floor-line py-2 ${
        align === "start" ? "items-start" : "items-center"
      }`}
    >
      <div className="text-quiet text-floor-mute">{label}</div>
      <div className="min-h-touch">{children}</div>
    </div>
  );
}

function centsToField(cents: number | null): string {
  if (cents === null || cents === 0) return "";
  return (cents / 100).toFixed(2);
}

export default function UnitDetailPage() {
  const { sku } = useParams<{ sku: string }>();
  const router = useRouter();
  const [unit, setUnit] = useState<Unit | null>(null);
  const [error, setError] = useState("");
  const [role, setRole] = useState("staff");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => setRole(data.user?.role ?? "staff"))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch(`/api/units/${sku}`)
      .then(async (res) => {
        const data = await res.json();
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        if (!res.ok) {
          setError(data.error ?? "Not found");
          setUnit(null);
          return;
        }
        setError("");
        setUnit(data.unit);
      })
      .catch(() => setError("Not found"));
  }, [sku, router]);

  const identity = unit ? unit.title || [unit.brand, unit.model].filter(Boolean).join(" ") : "";
  const price = unit ? displayAskCents(unit) : null;

  return (
    <Shell>
      <Link href="/inventory" className="btn-text px-0">
        Inventory
      </Link>
      {error ? <p className="mt-4 text-title text-floor-danger">{error}</p> : null}
      {unit ? (
        <article className="mt-3">
          {unit.recordError ? <p className="mb-3 text-body text-floor-danger">{unit.recordError}</p> : null}
          <p className="text-quiet tabular-nums tracking-wide text-floor-mute">{unit.sku}</p>
          <p className="mt-1 text-title">
            <EmptyValue>{identity}</EmptyValue>
            {price ? <span className="text-floor-mute"> {formatUsd(price)}</span> : null}
          </p>
          <p className="mt-1 text-quiet text-floor-mute">
            {unit.state}
            {unit.condition ? ` · ${unit.condition}` : ""}
          </p>
          <UnitPhotos sku={unit.sku} unit={unit} onUnit={setUnit} />
          <UnitEditor unit={unit} onSaved={setUnit} onSkuChanged={(next) => router.replace(`/inventory/${next}`)} role={role} />
          <QuickSell unit={unit} onSold={setUnit} />
          {role === "admin" ? <DeleteButton sku={unit.sku} /> : null}
        </article>
      ) : null}
    </Shell>
  );
}

function UnitEditor({
  unit,
  onSaved,
  onSkuChanged,
  role,
}: {
  unit: Unit;
  onSaved: (unit: Unit) => void;
  onSkuChanged: (sku: string) => void;
  role: string;
}) {
  const [config, setConfig] = useState<FloorConfig | null>(null);
  const [sku, setSku] = useState(unit.sku);
  const [brand, setBrand] = useState(unit.brand);
  const [model, setModel] = useState(unit.model);
  const [title, setTitle] = useState(unit.title);
  const [category, setCategory] = useState(unit.category);
  const [upc, setUpc] = useState(unit.upc);
  const [condition, setCondition] = useState(unit.condition ?? "");
  const [testStatus, setTestStatus] = useState(unit.testStatus ?? "untested");
  const [defectNotes, setDefectNotes] = useState(unit.defectNotes ?? "");
  const [mfrSerial, setMfrSerial] = useState(unit.mfrSerial ?? "");
  const [msrp, setMsrp] = useState(centsToField(unit.msrpCents));
  const [retail, setRetail] = useState(centsToField(unit.retail.cents));
  const [retailer, setRetailer] = useState(unit.retail.retailer ?? "");
  const [capturedOn, setCapturedOn] = useState(unit.retail.capturedOn ?? "");
  const [ask, setAsk] = useState(centsToField(displayAskCents(unit)));
  const [floor, setFloor] = useState(centsToField(unit.floorCents));
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [more, setMore] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => setConfig(data.config));
  }, []);

  useEffect(() => {
    setSku(unit.sku);
    setBrand(unit.brand);
    setModel(unit.model);
    setTitle(unit.title);
    setCategory(unit.category);
    setUpc(unit.upc);
    setCondition(unit.condition ?? "");
    setTestStatus(unit.testStatus ?? "untested");
    setDefectNotes(unit.defectNotes ?? "");
    setMfrSerial(unit.mfrSerial ?? "");
    setMsrp(centsToField(unit.msrpCents));
    setRetail(centsToField(unit.retail.cents));
    setRetailer(unit.retail.retailer ?? "");
    setCapturedOn(unit.retail.capturedOn ?? "");
    setAsk(centsToField(displayAskCents(unit)));
    setFloor(centsToField(unit.floorCents));
  }, [unit]);

  const askCents = ask === "" ? null : Math.round(Number(ask) * 100);
  const retailCents = retail === "" ? null : Math.round(Number(retail) * 100);
  const off = discountOffRetail(
    Number.isFinite(askCents) ? askCents : null,
    Number.isFinite(retailCents) ? retailCents : null,
  );
  const stale = isRetailStale(capturedOn || null, config?.retailStaleDays ?? 60);

  async function patch(body: Record<string, unknown>) {
    setError("");
    const res = await fetch(`/api/units/${unit.sku}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Save failed — form kept");
      return null;
    }
    onSaved(data.unit);
    setSaved("Saved");
    return data.unit as Unit;
  }

  async function saveSku() {
    const next = sku.replace(/\D/g, "").slice(0, 5);
    if (next === unit.sku) return;
    const updated = await patch({ op: "sku", nextSku: next });
    if (updated) onSkuChanged(updated.sku);
  }

  async function savePart() {
    if (
      brand === unit.brand &&
      model === unit.model &&
      title === unit.title &&
      category === unit.category &&
      upc === unit.upc
    ) {
      return;
    }
    if (unit.sharedModelCount > 1) {
      const ok = window.confirm(
        `Brand, model, title, category, and UPC are shared by ${unit.sharedModelCount} units of this model. Save anyway?`,
      );
      if (!ok) {
        setBrand(unit.brand);
        setModel(unit.model);
        setTitle(unit.title);
        setCategory(unit.category);
        setUpc(unit.upc);
        return;
      }
    }
    await patch({ op: "part", brand, model, title, category, upc });
  }

  async function saveInspect(next?: {
    condition?: string;
    testStatus?: string;
    defectNotes?: string;
    mfrSerial?: string;
  }) {
    await patch({
      op: "inspect",
      condition: (next?.condition ?? condition) || null,
      testStatus: next?.testStatus ?? testStatus,
      defectNotes: next?.defectNotes ?? defectNotes,
      mfrSerial: next?.mfrSerial ?? mfrSerial,
    });
  }

  async function savePrice() {
    const nextAsk = ask === "" ? null : Math.round(Number(ask) * 100);
    const shown = displayAskCents(unit);
    const askPayload = unit.askCents == null && nextAsk === shown ? "" : ask;
    await patch({ op: "price", msrp, retail, retailer, capturedOn, ask: askPayload, floor });
  }

  return (
    <div className="mt-6">
      <Row label="SKU">
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value.replace(/\D/g, "").slice(0, 5))}
          onBlur={() => void saveSku()}
          inputMode="numeric"
          maxLength={5}
          className="field tracking-widest"
        />
      </Row>
      <Row label="Brand">
        <input value={brand} onChange={(e) => setBrand(e.target.value)} onBlur={() => void savePart()} className="field" />
      </Row>
      <Row label="Model">
        <input value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => void savePart()} className="field" />
      </Row>
      <Row label="Description" align="start">
        <textarea
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void savePart()}
          className="field min-h-24 py-2"
        />
      </Row>
      <Row label="Condition">
        <select
          value={condition}
          onChange={(e) => {
            setCondition(e.target.value);
            void saveInspect({ condition: e.target.value });
          }}
          className="field"
        >
          <option value=""></option>
          {(config?.conditions ?? []).map((row) => (
            <option key={row} value={row}>
              {row}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Price">
        <span className="flex items-center gap-1">
          <span className="text-floor-mute">$</span>
          <input
            inputMode="decimal"
            value={ask}
            onChange={(e) => setAsk(e.target.value.replace(/[^0-9.]/g, ""))}
            onBlur={() => void savePrice()}
            className="field tabular-nums"
          />
        </span>
      </Row>
      <Row label="MSRP">
        <span className="flex items-center gap-1">
          <span className="text-floor-mute">$</span>
          <input
            inputMode="decimal"
            value={msrp}
            onChange={(e) => setMsrp(e.target.value.replace(/[^0-9.]/g, ""))}
            onBlur={() => void savePrice()}
            className="field tabular-nums"
          />
        </span>
      </Row>
      {off !== null ? <p className="py-2 text-quiet text-floor-mute">{off}% off retail</p> : null}
      {stale ? <p className="py-2 text-quiet text-floor-danger">Retail reference is stale</p> : null}
      <button type="button" onClick={() => setMore((value) => !value)} className="btn-text mt-3 px-0">
        {more ? "Less" : "More"}
      </button>
      {more ? (
        <div className="mt-2">
          <p className="my-3 text-quiet text-floor-mute">
            Brand, model, description, category, and UPC are shared by every unit of this model
            {unit.sharedModelCount > 1 ? ` (${unit.sharedModelCount} units)` : ""}.
          </p>
          <Row label="Category">
            <input value={category} onChange={(e) => setCategory(e.target.value)} onBlur={() => void savePart()} className="field" />
          </Row>
          <Row label="UPC">
            <input value={upc} onChange={(e) => setUpc(e.target.value)} onBlur={() => void savePart()} className="field" />
          </Row>
          <Row label="Test">
            <select
              value={testStatus}
              onChange={(e) => {
                setTestStatus(e.target.value);
                void saveInspect({ testStatus: e.target.value });
              }}
              className="field"
            >
              {(config?.testStatuses ?? ["untested"]).map((row) => (
                <option key={row} value={row}>
                  {row}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Mfr serial">
            <input value={mfrSerial} onChange={(e) => setMfrSerial(e.target.value)} onBlur={() => void saveInspect()} className="field" />
          </Row>
          <Row label="Defects">
            <textarea
              value={defectNotes}
              onChange={(e) => setDefectNotes(e.target.value)}
              onBlur={() => void saveInspect()}
              className="field min-h-24 py-2"
            />
          </Row>
          <Row label="Retail ref">
            <input
              inputMode="decimal"
              value={retail}
              onChange={(e) => setRetail(e.target.value.replace(/[^0-9.]/g, ""))}
              onBlur={() => void savePrice()}
              className="field tabular-nums"
            />
          </Row>
          <Row label="Retailer">
            <input value={retailer} onChange={(e) => setRetailer(e.target.value)} onBlur={() => void savePrice()} className="field" />
          </Row>
          <Row label="Captured">
            <input type="date" value={capturedOn} onChange={(e) => setCapturedOn(e.target.value)} onBlur={() => void savePrice()} className="field" />
          </Row>
          {role === "admin" ? (
            <Row label="Floor">
              <input
                inputMode="decimal"
                value={floor}
                onChange={(e) => setFloor(e.target.value.replace(/[^0-9.]/g, ""))}
                onBlur={() => void savePrice()}
                className="field tabular-nums"
              />
            </Row>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="mt-3 text-body text-floor-danger">{error}</p> : null}
      {saved ? <p className="mt-3 text-quiet text-floor-ok">{saved}</p> : null}
    </div>
  );
}

function DeleteButton({ sku }: { sku: string }) {
  const router = useRouter();
  const [error, setError] = useState("");

  async function del() {
    if (!window.confirm(`Delete ${sku}? This cannot be undone, and the SKU cannot be reused.`)) return;
    setError("");
    const res = await fetch(`/api/units/${sku}/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ typedSku: sku }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Delete failed");
    else router.replace("/inventory");
  }

  return (
    <div className="mt-10">
      <button type="button" onClick={() => void del()} className="btn-text px-0 text-floor-danger">
        Delete unit
      </button>
      {error ? <p className="mt-2 text-body text-floor-danger">{error}</p> : null}
    </div>
  );
}
