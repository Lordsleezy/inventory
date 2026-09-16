"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { Unit } from "@floor/domain";
import { displayAskCents, formatUsd } from "@floor/domain";

function LabelSheet() {
  const params = useSearchParams();
  const skus = (params.get("skus") ?? "").split(",").filter(Boolean);
  const [units, setUnits] = useState<Unit[]>([]);

  useEffect(() => {
    Promise.all(skus.map((sku) => fetch(`/api/units/${sku}`).then((res) => res.json()))).then((rows) => {
      setUnits(rows.map((row) => row.unit).filter(Boolean));
    });
  }, [skus.join(",")]);

  return (
    <div className="label-root bg-white text-black">
      <style>{`
        .label-root { font-family: ui-sans-serif, system-ui, sans-serif; }
        .label-card { break-inside: avoid; border: 1px solid #111; padding: 12px; margin: 8px; width: 3.5in; min-height: 2in; }
        .label-sku { font-size: 64px; font-weight: 900; letter-spacing: 0.12em; line-height: 1; }
        .label-meta { font-size: 18px; margin-top: 8px; }
        .label-price { font-size: 28px; font-weight: 800; margin-top: 6px; min-height: 34px; }
        .label-barcode { margin-top: 8px; }
        @media print {
          body { background: white; }
          .no-print { display: none; }
        }
      `}</style>
      <div className="no-print p-3">
        <button type="button" onClick={() => window.print()} className="min-h-11 rounded bg-black px-4 font-bold text-white">
          Print
        </button>
      </div>
      <div className="flex flex-wrap p-2">
        {units.map((unit) => (
          <article key={unit.sku} className="label-card">
            <div className="label-sku">{unit.sku}</div>
            <div className="label-meta">
              {[unit.brand, unit.model].filter(Boolean).join(" ")}
              {unit.condition ? ` · ${unit.condition}` : ""}
            </div>
            <div className="label-price">{formatUsd(displayAskCents(unit))}</div>
            <svg className="label-barcode" data-sku={unit.sku} width="220" height="48">
              <text x="0" y="36" fontFamily="monospace" fontSize="18">
                *{unit.sku}*
              </text>
            </svg>
          </article>
        ))}
      </div>
    </div>
  );
}

export default function LabelsPage() {
  return (
    <Suspense>
      <LabelSheet />
    </Suspense>
  );
}
