import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { formatCents, listUnits, type Unit, type UnitState } from "@floor/store";
import { useDb } from "../store";
import { Notice, Spinner } from "../components/ui";

const FILTERS: { key: string; label: string; states?: UnitState[] }[] = [
  { key: "stock", label: "In stock", states: ["available", "reserved", "repair"] },
  { key: "sold", label: "Sold", states: ["sold"] },
  { key: "other", label: "Out", states: ["voided", "scrapped", "lost"] },
  { key: "all", label: "All" },
];

export function InventoryScreen() {
  const db = useDb();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("stock");
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [error, setError] = useState("");

  const states = useMemo(() => FILTERS.find((f) => f.key === filter)?.states, [filter]);

  useEffect(() => {
    let live = true;
    // Searching runs against the local file, so there is no debounce to hide
    // network latency — there is no network.
    void listUnits(db, { query, states })
      .then((rows) => live && setUnits(rows))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [db, query, states]);

  return (
    <section>
      <div className="flex items-center gap-2">
        <input
          className="field"
          value={query}
          placeholder="SKU, brand or model"
          inputMode="search"
          autoCorrect="off"
          autoCapitalize="none"
          onChange={(e) => setQuery(e.target.value)}
        />
        <Link to="/receive" className="btn-accent shrink-0">
          Receive
        </Link>
      </div>

      <div className="mt-3 flex flex-wrap gap-3">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className={`min-h-touch text-quiet ${filter === item.key ? "text-floor-accent" : "text-floor-mute"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <Notice tone="error">{error}</Notice>

      {units === null ? <Spinner label="Reading" /> : null}

      {units?.length === 0 ? (
        <p className="py-6 text-quiet text-floor-mute">
          {query
            ? `Nothing matches “${query}”.`
            : filter === "stock"
              ? "Nothing in stock."
              : "Nothing here yet."}
        </p>
      ) : null}

      <ul>
        {units?.map((unit) => (
          <li key={unit.sku} className="border-b border-floor-line">
            <Link to={`/inventory/${unit.sku}`} className="flex min-h-touch items-center gap-3 py-3">
              <span className="w-14 shrink-0 font-mono text-body text-floor-mute">{unit.sku}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body">
                  {[unit.brand, unit.model].filter(Boolean).join(" ") || unit.title || "Untitled"}
                </span>
                <span className="block truncate text-quiet text-floor-mute">
                  {[unit.condition, unit.location].filter(Boolean).join(" · ") || "—"}
                </span>
              </span>
              <span className="shrink-0 text-right">
                {/* An unpriced unit shows nothing at all, not $0.00. */}
                <span className="block text-body">{formatCents(unit.askCents) || "—"}</span>
                {unit.state !== "available" ? (
                  <span className="block text-quiet text-floor-mute">{unit.state}</span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {units?.length ? (
        <p className="py-4 text-quiet text-floor-mute">
          {units.length} {units.length === 1 ? "unit" : "units"}
        </p>
      ) : null}
    </section>
  );
}
