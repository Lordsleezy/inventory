import { useMemo, useState } from "react";
import { SHIPPING_AUDIT, type ShippingAuditRow } from "./shippingAuditData";

const FILTERS = [
  ["all", "All"],
  ["too_high", "Too high"],
  ["too_low", "Too low"],
  ["fine", "Fine"],
  ["cant_tell", "Can't tell"],
] as const;

function usd(value: number | "") {
  if (value === "" || value == null || Number.isNaN(Number(value))) return "—";
  return `$${Number(value).toFixed(2)}`;
}

function verdictLabel(verdict: string) {
  if (verdict === "too_high") return "Too high";
  if (verdict === "too_low") return "Too low";
  if (verdict === "cant_tell") return "Can't tell";
  return "Fine";
}

export function ShippingAuditPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [query, setQuery] = useState("");
  const counts = SHIPPING_AUDIT.counts;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return SHIPPING_AUDIT.rows.filter((row) => {
      if (filter !== "all" && row.verdict !== filter) return false;
      if (!needle) return true;
      return `${row.listingId} ${row.sku} ${row.title}`.toLowerCase().includes(needle);
    });
  }, [filter, query]);

  return (
    <section className="panel">
      <p>
        Read only. Buyer shipping is compared with the November 2026 USPS Ground Advantage commercial card
        from {SHIPPING_AUDIT.origin}, priced at zone {SHIPPING_AUDIT.zone} ({SHIPPING_AUDIT.zoneRule}).
        The charge covers that label after a {Math.round(SHIPPING_AUDIT.feeRate * 1000) / 10}% eBay fee
        and stays at least $6. A listing in the $10–$12.50 band is left alone unless it is more than $4 high.
        Nothing on this page changes a listing. The Ground column is the price buyers see first.
        On November 10, 2026 the copied boxes were corrected and Ground Advantage was moved ahead of Priority
        on the calculated policies. Rows that changed say so.
      </p>
      <div className="tabs" role="tablist">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
            {label}{id === "all" ? ` ${SHIPPING_AUDIT.rows.length}` : ` ${counts[id] || 0}`}
          </button>
        ))}
      </div>
      <p>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Listing, SKU, or title" aria-label="Filter shipping check" />
      </p>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Listing</th>
              <th>SKU</th>
              <th>Title</th>
              <th className="n">Price</th>
              <th className="n">Ground</th>
              <th className="n">Priority</th>
              <th className="n">Should be</th>
              <th className="n">Difference</th>
              <th>Verdict</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: ShippingAuditRow) => (
              <tr key={row.listingId}>
                <td>{row.listingId}</td>
                <td>{row.sku}</td>
                <td>{row.title}</td>
                <td className="n">{usd(row.price)}</td>
                <td className="n">{usd(row.ga)}</td>
                <td className="n">{usd(row.pm)}</td>
                <td className="n">{usd(row.shouldBe)}</td>
                <td className="n">{usd(row.difference)}</td>
                <td>{verdictLabel(row.verdict)}</td>
                <td>{row.why}{row.source ? ` Source: ${row.source}.` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p>No listings in this view.</p>}
    </section>
  );
}
