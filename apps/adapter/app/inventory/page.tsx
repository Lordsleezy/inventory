"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { Unit } from "@floor/domain";
import { Shell } from "@/components/shell";
import { SkuKeypad } from "@/components/sku-keypad";
import { UnitPreview } from "@/components/unit-preview";
import { EmptyValue, Money } from "@/components/empty-value";

type Queue = "" | "inspect" | "price" | "unlisted" | "error" | "voided" | "nophoto";

let cachedUnits: Unit[] = [];

export default function InventoryPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [queue, setQueue] = useState<Queue>("");
  const [units, setUnits] = useState<Unit[]>(cachedUnits);
  const [loadError, setLoadError] = useState("");
  const [sku, setSku] = useState("");
  const [lookup, setLookup] = useState<Unit | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (queue) params.set("queue", queue);
    const ac = new AbortController();
    fetch(`/api/units?${params}`, { signal: ac.signal })
      .then(async (res) => {
        if (res.status === 401) {
          router.replace("/login");
          return;
        }
        const data = await res.json();
        if (!res.ok) {
          setLoadError(data.error ?? "Could not load inventory");
          return;
        }
        const next = data.units ?? [];
        cachedUnits = next;
        setUnits(next);
        setLoadError("");
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoadError("Could not load inventory");
      });
    return () => ac.abort();
  }, [q, queue, router]);

  useEffect(() => {
    if (sku.length !== 5) {
      setLookup(null);
      setMissing(false);
      return;
    }
    fetch(`/api/units/${sku}`)
      .then(async (res) => {
        const data = await res.json();
        if (res.status === 404) {
          setLookup(null);
          setMissing(true);
          return;
        }
        setMissing(false);
        setLookup(data.unit ?? null);
      })
      .catch(() => {
        setLookup(null);
        setMissing(true);
      });
  }, [sku]);

  const chips: { id: Queue; label: string }[] = [
    { id: "", label: "All" },
    { id: "inspect", label: "Need inspect" },
    { id: "price", label: "Need price" },
    { id: "unlisted", label: "Priced, not listed" },
    { id: "error", label: "Record error" },
    { id: "nophoto", label: "No photo" },
    { id: "voided", label: "Voided" },
  ];

  return (
    <Shell>
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <section>
          <SkuKeypad
            value={sku}
            onChange={setSku}
            onEnter={() => {
              if (lookup) router.push(`/inventory/${lookup.sku}`);
            }}
            onClear={() => {
              setLookup(null);
              setMissing(false);
            }}
          />
          <div className="mt-3">
            <UnitPreview unit={lookup} missing={missing} />
            {lookup ? (
              <Link
                href={`/inventory/${lookup.sku}`}
                className="mt-2 flex min-h-touch items-center justify-center rounded-lg bg-floor-accent text-lg font-black text-black"
              >
                Open {lookup.sku}
              </Link>
            ) : null}
          </div>
        </section>
        <section>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search SKU, brand, model, location…"
            className="min-h-touch w-full rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {chips.map((chip) => (
              <button
                key={chip.id || "all"}
                type="button"
                onClick={() => setQueue(chip.id)}
                className={`min-h-touch rounded-lg px-3 font-bold ${
                  queue === chip.id ? "bg-floor-accent text-black" : "bg-floor-panel text-floor-text"
                }`}
              >
                {chip.label}
              </button>
            ))}
          </div>
          <p className="mt-2 text-sm text-floor-mute">{units.length} items</p>
          {loadError ? <p className="mt-1 font-bold text-floor-danger">{loadError}</p> : null}
          <Link href="/photos" className="mt-1 inline-flex min-h-touch items-center font-bold text-floor-accent">
            Unmatched photos
          </Link>
          <div className="mt-2 grid gap-2">
            {units.map((unit) => (
              <Link
                key={unit.sku}
                href={`/inventory/${unit.sku}`}
                className="min-h-touch rounded-xl border border-floor-line bg-floor-panel p-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-3xl font-black tracking-widest text-floor-accent">{unit.sku}</span>
                  <Money cents={unit.askCents} />
                </div>
                <p className="text-lg font-semibold">
                  <EmptyValue>{[unit.brand, unit.model].filter(Boolean).join(" ")}</EmptyValue>
                </p>
                <p className="text-sm text-floor-mute">
                  <EmptyValue>{unit.condition}</EmptyValue>
                  {unit.location ? ` · ${unit.location}` : ""}
                  {unit.recordError ? ` · ${unit.recordError}` : ""}
                </p>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </Shell>
  );
}
