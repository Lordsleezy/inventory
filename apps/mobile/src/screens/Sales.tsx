import { useEffect, useState } from "react";
import {
  buildReceipt,
  formatCents,
  loadUnit,
  receiptHtml,
  salesCsv,
  salesHistory,
  type Sale,
} from "@floor/store";
import { Link } from "react-router-dom";
import { openHtml, saveAndShare, stampedName } from "../files";
import { useStore } from "../store";
import { Notice, Spinner } from "../components/ui";

export function SalesScreen() {
  const { db, settings } = useStore();
  const [query, setQuery] = useState("");
  const [includeVoided, setIncludeVoided] = useState(false);
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  useEffect(() => {
    let live = true;
    void salesHistory(db, { query, includeVoided })
      .then((rows) => live && setSales(rows))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [db, query, includeVoided]);

  async function receiptFor(sale: Sale) {
    const unit = await loadUnit(db, sale.sku);
    const receipt = buildReceipt(sale, unit, settings);
    await openHtml(`receipt-${receipt.receiptNo}.html`, receiptHtml(receipt));
  }

  async function exportCsv() {
    setError("");
    try {
      const file = await saveAndShare(
        stampedName("floor-sales", "csv"),
        await salesCsv(db),
        "text/csv",
        "Floor sales",
      );
      setSaved(`Saved ${file.filename} to ${file.where}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const live = sales?.filter((sale) => !sale.voidedAt) ?? [];
  const total = live.reduce((sum, sale) => sum + sale.priceCents, 0);

  return (
    <section>
      <h1 className="text-title">Sales</h1>

      <input
        className="field mt-3"
        value={query}
        placeholder="SKU, customer or receipt"
        inputMode="search"
        autoCapitalize="none"
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex min-h-touch items-center gap-2 text-quiet text-floor-mute">
          <input
            type="checkbox"
            checked={includeVoided}
            onChange={(e) => setIncludeVoided(e.target.checked)}
          />
          Show voided
        </label>
        <button type="button" className="btn-text px-0" onClick={() => void exportCsv()}>
          Export CSV
        </button>
      </div>

      <Notice tone="error">{error}</Notice>
      <Notice tone="ok">{saved}</Notice>

      {sales === null ? <Spinner label="Reading" /> : null}
      {sales?.length === 0 ? <p className="py-6 text-quiet text-floor-mute">No sales yet.</p> : null}

      <ul className="mt-2">
        {sales?.map((sale) => (
          <li key={sale.id} className="border-b border-floor-line py-3">
            <div className="flex items-baseline gap-3">
              <Link to={`/inventory/${sale.sku}`} className="w-14 shrink-0 font-mono text-body text-floor-mute">
                {sale.sku}
              </Link>
              <span className="min-w-0 flex-1">
                <span className="block text-body">
                  {formatCents(sale.priceCents)}
                  <span className="text-floor-mute"> · {sale.channel}</span>
                </span>
                <span className="block truncate text-quiet text-floor-mute">
                  {new Date(sale.soldAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}{" "}
                  · {sale.receiptNo}
                  {sale.customerName ? ` · ${sale.customerName}` : ""}
                </span>
                {sale.voidedAt ? (
                  <span className="block text-quiet text-floor-danger">
                    Voided{sale.voidReason ? ` · ${sale.voidReason}` : ""}
                  </span>
                ) : null}
              </span>
              <button type="button" className="btn-text shrink-0 px-0" onClick={() => void receiptFor(sale)}>
                Receipt
              </button>
            </div>
          </li>
        ))}
      </ul>

      {live.length ? (
        <p className="py-4 text-quiet text-floor-mute">
          {live.length} {live.length === 1 ? "sale" : "sales"} · {formatCents(total)}
        </p>
      ) : null}
    </section>
  );
}
