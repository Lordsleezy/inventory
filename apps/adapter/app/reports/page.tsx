"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { formatUsd, type SaleHistoryRow } from "@floor/domain";
import { Shell } from "@/components/shell";

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
      <h1 className="mb-3 text-2xl font-black">Sales history</h1>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search SKU, date, or customer"
        className="mb-4 min-h-touch w-full max-w-xl rounded-lg border border-floor-line bg-floor-panel px-3 text-lg"
      />
      {error ? <p className="font-bold text-floor-danger">{error}</p> : null}
      {!rows.length && !error ? <p className="text-floor-mute">No completed sales match.</p> : null}
      <div className="grid gap-3">
        {rows.map((row) => (
          <article key={row.id} className="rounded-xl border border-floor-line bg-floor-panel p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xl font-black">{row.reference}</p>
              <p className="font-black">{formatUsd(row.totalCents)}</p>
            </div>
            <p className="text-floor-mute">
              {row.soldOn ? row.soldOn.slice(0, 10) : ""} · {row.channel}
              {row.customerName ? ` · ${row.customerName}` : ""}
            </p>
            <p className="mt-2">{row.lineSummary}</p>
            <Link
              href={`/receipt?sale=${row.id}`}
              className="mt-3 inline-flex min-h-touch items-center font-bold text-floor-accent"
            >
              View / reprint receipt
            </Link>
          </article>
        ))}
      </div>
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
