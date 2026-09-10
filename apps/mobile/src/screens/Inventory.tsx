import { displayAskCents, filterUnits, formatUsd, matchesInventoryQuery, type Unit } from "@floor/domain";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiJson } from "../api";
import { Shell } from "../components/Shell";

type Queue = "" | "inspect" | "price" | "unlisted" | "error" | "voided" | "nophoto" | "sold";

function listPrice(cents: number | null): string {
  if (cents == null || cents === 0) return "";
  return formatUsd(cents);
}

export function InventoryScreen() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [queue, setQueue] = useState<Queue>("");
  const [brand, setBrand] = useState("");
  const [allUnits, setAllUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiJson<{ units?: Unit[]; error?: string }>("/api/units?includeVoided=1").then(({ ok, status, data }) => {
      if (cancelled) return;
      if (status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      if (!ok) {
        setLoadError(data.error ?? "Could not load inventory");
        setLoading(false);
        return;
      }
      setAllUnits(data.units ?? []);
      setLoadError("");
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const brands = useMemo(() => {
    const seen = new Map<string, string>();
    for (const unit of allUnits) {
      const label = unit.brand.trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (!seen.has(key)) seen.set(key, label);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [allUnits]);

  const units = useMemo(() => {
    const queued = filterUnits(allUnits, { queue: queue || undefined });
    return queued.filter((unit) => {
      if (brand && unit.brand.trim().toLowerCase() !== brand) return false;
      return matchesInventoryQuery(unit, q);
    });
  }, [allUnits, q, queue, brand]);

  const chips: { id: Queue; label: string }[] = [
    { id: "", label: "All" },
    { id: "inspect", label: "Need inspect" },
    { id: "price", label: "Need price" },
    { id: "unlisted", label: "Priced, not listed" },
    { id: "error", label: "Record error" },
    { id: "nophoto", label: "No photo" },
    { id: "voided", label: "Voided" },
    { id: "sold", label: "Sold" },
  ];
  const activeChip = chips.find((chip) => chip.id === queue) ?? chips[0];

  return (
    <Shell>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search SKU, brand, model, title"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        className="field min-w-0 text-title"
        aria-label="Search inventory"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setQueue("");
            setBrand("");
          }}
          className={`min-h-touch px-1 text-body ${queue === "" && !brand ? "text-floor-text" : "text-floor-mute"}`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setFiltersOpen((open) => !open)}
          className={`min-h-touch px-1 text-body ${queue || brand ? "text-floor-text" : "text-floor-mute"}`}
        >
          {filtersOpen
            ? "Filter · hide"
            : brand
              ? `Filter · ${brands.find(([key]) => key === brand)?.[1] ?? brand}`
              : queue
                ? `Filter · ${activeChip.label}`
                : "Filter"}
        </button>
      </div>
      {filtersOpen ? (
        <div className="mt-2">
          <p className="text-quiet text-floor-mute">Brands</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {brands.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setBrand(key === brand ? "" : key);
                  setQueue("");
                }}
                className={`min-h-touch px-2 text-body ${brand === key ? "text-floor-text" : "text-floor-mute"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-quiet text-floor-mute">Status</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {chips
              .filter((chip) => chip.id)
              .map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => {
                    setQueue(chip.id);
                    setBrand("");
                    setFiltersOpen(false);
                  }}
                  className={`min-h-touch px-2 text-body ${queue === chip.id ? "text-floor-text" : "text-floor-mute"}`}
                >
                  {chip.label}
                </button>
              ))}
          </div>
        </div>
      ) : null}
      <p className="mt-4 text-quiet text-floor-mute">
        {loading ? "Loading…" : `${units.length} ${units.length === 1 ? "item" : "items"}`}
        {loadError ? ` · ${loadError}` : ""}
      </p>
      {loadError ? <p className="mt-1 text-body text-floor-danger">{loadError}</p> : null}
      <ul className="mt-2">
        {units.map((unit) => {
          const title = unit.title || [unit.brand, unit.model].filter(Boolean).join(" ");
          const price = listPrice(displayAskCents(unit));
          return (
            <li key={unit.sku} className="border-b border-floor-line">
              <Link to={`/inventory/${unit.sku}`} className="flex min-h-touch items-baseline gap-3 py-3">
                <span className="w-14 shrink-0 text-quiet tabular-nums text-floor-mute">{unit.sku}</span>
                <span className="min-w-0 flex-1 break-words text-title">
                  {title || price ? (
                    <>
                      {title || null}
                      {title && price ? " " : null}
                      {price ? <span className="text-floor-mute">{price}</span> : null}
                      {unit.state === "sold" ? <span className="text-quiet text-floor-mute"> sold</span> : null}
                    </>
                  ) : (
                    "—"
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}
