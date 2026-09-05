"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FloorConfig, Unit } from "@floor/domain";
import { Shell } from "@/components/shell";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-2 border-b border-floor-line py-3 text-lg">
      <div className="text-floor-mute">{label}</div>
      <div className="min-h-6">{children}</div>
    </div>
  );
}

const fieldClass = "min-h-touch w-full rounded-lg border border-floor-line bg-black px-3 text-lg";

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

  return (
    <Shell>
      <Link href="/inventory" className="inline-flex min-h-touch items-center font-bold text-floor-accent">
        ← Inventory
      </Link>
      {error ? <p className="mt-4 text-2xl font-black text-floor-danger">{error}</p> : null}
      {unit ? (
        <article className="mt-4 rounded-xl border border-floor-line bg-floor-panel p-4">
          {unit.recordError ? <p className="mb-3 text-floor-danger">{unit.recordError}</p> : null}
          {unit.state === "sold" && unit.sale?.salesOrderId ? (
            <p className="mb-3">
              <Link href={`/receipt?sale=${unit.sale.salesOrderId}`} className="font-bold text-floor-accent">
                Receipt
              </Link>
              {" · "}
              <Link href={`/reports?sku=${unit.sku}`} className="font-bold text-floor-accent">
                Sales history
              </Link>
            </p>
          ) : null}
          <UnitEditor unit={unit} onSaved={setUnit} onSkuChanged={(next) => router.replace(`/inventory/${next}`)} />
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
}: {
  unit: Unit;
  onSaved: (unit: Unit) => void;
  onSkuChanged: (sku: string) => void;
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
  const [location, setLocation] = useState(unit.location ?? "");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

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
    setLocation(unit.location ?? "");
  }, [unit]);

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
    location?: string;
  }) {
    await patch({
      op: "inspect",
      condition: (next?.condition ?? condition) || null,
      testStatus: next?.testStatus ?? testStatus,
      defectNotes: next?.defectNotes ?? defectNotes,
      mfrSerial: next?.mfrSerial ?? mfrSerial,
      location: next?.location ?? location,
    });
  }

  return (
    <div>
      <Row label="SKU">
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value.replace(/\D/g, "").slice(0, 5))}
          onBlur={() => void saveSku()}
          inputMode="numeric"
          maxLength={5}
          className={`${fieldClass} tracking-widest font-black text-floor-accent`}
        />
      </Row>
      <p className="my-2 rounded-lg border border-floor-line bg-black/40 px-3 py-2 text-sm text-floor-mute">
        Brand, model, title, category, and UPC are shared by every unit of this model
        {unit.sharedModelCount > 1 ? ` (${unit.sharedModelCount} units)` : ""}. Changing them here changes all of them.
      </p>
      <Row label="Brand">
        <input value={brand} onChange={(e) => setBrand(e.target.value)} onBlur={() => void savePart()} className={fieldClass} />
      </Row>
      <Row label="Model">
        <input value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => void savePart()} className={fieldClass} />
      </Row>
      <Row label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void savePart()} className={fieldClass} />
      </Row>
      <Row label="Category">
        <input value={category} onChange={(e) => setCategory(e.target.value)} onBlur={() => void savePart()} className={fieldClass} />
      </Row>
      <Row label="UPC">
        <input value={upc} onChange={(e) => setUpc(e.target.value)} onBlur={() => void savePart()} className={fieldClass} />
      </Row>
      <Row label="Condition">
        <select
          value={condition}
          onChange={(e) => {
            setCondition(e.target.value);
            void saveInspect({ condition: e.target.value });
          }}
          className={fieldClass}
        >
          <option value=""></option>
          {(config?.conditions ?? []).map((row) => (
            <option key={row} value={row}>
              {row}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Test">
        <select
          value={testStatus}
          onChange={(e) => {
            setTestStatus(e.target.value);
            void saveInspect({ testStatus: e.target.value });
          }}
          className={fieldClass}
        >
          {(config?.testStatuses ?? ["untested"]).map((row) => (
            <option key={row} value={row}>
              {row}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Location">
        <input value={location} onChange={(e) => setLocation(e.target.value)} onBlur={() => void saveInspect()} className={fieldClass} />
      </Row>
      <Row label="Mfr serial">
        <input value={mfrSerial} onChange={(e) => setMfrSerial(e.target.value)} onBlur={() => void saveInspect()} className={fieldClass} />
      </Row>
      <Row label="Defects">
        <textarea
          value={defectNotes}
          onChange={(e) => setDefectNotes(e.target.value)}
          onBlur={() => void saveInspect()}
          className="min-h-24 w-full rounded-lg border border-floor-line bg-black px-3 py-2 text-lg"
        />
      </Row>
      {error ? <p className="mt-3 font-bold text-floor-danger">{error}</p> : null}
      {saved ? <p className="mt-3 text-floor-ok">{saved}</p> : null}
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
    <div className="mt-6 border-t border-floor-line pt-4">
      <button type="button" onClick={() => void del()} className="min-h-touch rounded-lg bg-floor-danger px-4 font-black text-black">
        Delete
      </button>
      {error ? <p className="mt-2 font-bold text-floor-danger">{error}</p> : null}
    </div>
  );
}
