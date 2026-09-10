"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatUsd, type SaleHistoryRow } from "@floor/domain";
import { Shell } from "@/components/shell";
import { SaleReceiptUpload } from "@/components/sale-receipt-upload";

function SalesHistory() {
  const params = useSearchParams();
  const initial = params.get("sku") ?? params.get("q") ?? "";
  const [query, setQuery] = useState(initial);
  const [sales, setSales] = useState<SaleHistoryRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const q = new URLSearchParams();
    q.set("history", "1");
    if (query.trim()) q.set("q", query.trim());
    fetch(`/api/sales?${q}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Could not load sales");
          return;
        }
        setError("");
        setSales(data.sales ?? []);
      })
      .catch(() => setError("Could not load sales"));
  }, [query]);

  const rows = useMemo(() => sales, [sales]);

  return (
    <Shell>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search SKU, date, or customer"
        className="field mb-4 max-w-xl"
      />
      {error ? <p className="text-body text-floor-danger">{error}</p> : null}
      {!rows.length && !error ? <p className="text-quiet text-floor-mute">No completed sales match.</p> : null}
      <ul>
        {rows.map((row) => (
          <li key={row.id} className="border-b border-floor-line py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-title">{row.reference}</p>
              <p className="tabular-nums">{formatUsd(row.totalCents)}</p>
            </div>
            <p className="text-quiet text-floor-mute">
              {row.soldOn ? row.soldOn.slice(0, 10) : ""} · {row.channel}
              {row.customerName ? ` · ${row.customerName}` : ""}
            </p>
            <p className="mt-1 text-body">{row.lineSummary}</p>
            <SaleReceiptUpload
              saleId={row.id}
              file={row.receiptFile}
              onChange={(receiptFile) => {
                setSales((rows) => rows.map((sale) => (sale.id === row.id ? { ...sale, receiptFile } : sale)));
              }}
            />
          </li>
        ))}
      </ul>
    </Shell>
  );
}

export default function ReportsPage() {
  return (
    <Suspense>
      <SalesHistory />
    </Suspense>
  );
}
