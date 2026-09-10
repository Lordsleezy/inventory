import { formatUsd, type SaleHistoryRow } from "@floor/domain";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiJson } from "../api";
import { ReceiptUpload } from "../components/Receipt";
import { Shell } from "../components/Shell";

export function ReportsScreen() {
  const [params] = useSearchParams();
  const initial = params.get("sku") ?? params.get("q") ?? "";
  const [query, setQuery] = useState(initial);
  const [sales, setSales] = useState<SaleHistoryRow[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const q = new URLSearchParams();
    q.set("history", "1");
    if (query.trim()) q.set("q", query.trim());
    void apiJson<{ sales?: SaleHistoryRow[]; error?: string }>(`/api/sales?${q}`).then(({ ok, data }) => {
      if (!ok) {
        setError(data.error ?? "Could not load sales");
        return;
      }
      setError("");
      setSales(data.sales ?? []);
    });
  }, [query]);

  return (
    <Shell>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search SKU, date, or customer"
        className="field mb-4"
      />
      {error ? <p className="text-body text-floor-danger">{error}</p> : null}
      {!sales.length && !error ? <p className="text-quiet text-floor-mute">No completed sales match.</p> : null}
      <ul>
        {sales.map((row) => (
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
            <ReceiptUpload
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
