import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  countUnfinished,
  formatCents,
  listedChannelsBySku,
  listUnits,
  type Unit,
} from "@floor/store";
import { applyChannelListing } from "../functions";
import { useDb, useStore } from "../store";
import { EbayBulkEdit } from "../components/EbayDetails";
import { Notice, Spinner } from "../components/ui";
import { ChannelMarks, ChannelToggleRow, normalizeChannel } from "../listingMarks";
import { friendlyRpc } from "../rpc";

const FILTERS: {
  key: string;
  label: string;
  unfinished?: boolean;
}[] = [
  { key: "all", label: "All" },
  { key: "unfinished", label: "Unfinished", unfinished: true },
];

export function InventoryScreen() {
  const db = useDb();
  const { online, cacheEpoch, settings, hydrate, ensureOnline, session } = useStore();
  const admin = session.role !== "staff";
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [filter, setFilter] = useState(() => {
    const tab = (location.state as { filter?: string } | null)?.filter;
    return tab && FILTERS.some((f) => f.key === tab) ? tab : "all";
  });
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [listedMap, setListedMap] = useState<Map<string, string[]>>(new Map());
  const [unfinCount, setUnfinCount] = useState(0);
  const [error, setError] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  const tab = FILTERS.find((f) => f.key === filter);

  useEffect(() => {
    let live = true;
    void Promise.all([
      listUnits(db, {
        query,
        category: category || undefined,
        unfinished: tab?.unfinished,
      }),
      listedChannelsBySku(db),
      countUnfinished(db),
    ])
      .then(([rows, map, unfin]) => {
        if (!live) return;
        setUnits(rows);
        setListedMap(map);
        setUnfinCount(unfin);
      })
      .catch((err) => live && setError(friendlyRpc(err)));
    return () => {
      live = false;
    };
  }, [db, query, category, tab?.unfinished, cacheEpoch]);

  const channelOptions = useMemo(() => {
    const fromSettings = settings.channels.filter((c) => c !== "floor");
    for (const extra of ["facebook", "ebay", "amazon"]) {
      if (!fromSettings.some((c) => normalizeChannel(c) === extra)) fromSettings.push(extra);
    }
    return fromSettings;
  }, [settings.channels]);

  function togglePick(sku: string) {
    setPicked((prev) => (prev.includes(sku) ? prev.filter((s) => s !== sku) : [...prev, sku]));
  }

  async function applyListing(channel: string, next: boolean) {
    setError("");
    if (!picked.length) {
      setError("Select one or more units first.");
      return;
    }
    try {
      await ensureOnline();
      await applyChannelListing(channel, picked, next);
      await hydrate();
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  function channelNext(channel: string): boolean {
    const key = normalizeChannel(channel);
    if (!picked.length) return true;
    return !picked.every((sku) =>
      (listedMap.get(sku) ?? []).some((c) => normalizeChannel(c) === key),
    );
  }

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
        <Link to="/receive" className={`btn-accent shrink-0 ${!online ? "opacity-40" : ""}`}>
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
            {item.key === "unfinished" ? (
              <span className="ml-1 text-floor-accent">({unfinCount})</span>
            ) : null}
          </button>
        ))}
      </div>

      <select
        className="field mt-2"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
        aria-label="Filter by category"
      >
        <option value="">All categories</option>
        {settings.categories.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>

      {admin ? (
        <>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          className="btn-text px-0"
          onClick={() => {
            setSelecting((on) => !on);
            setPicked([]);
          }}
        >
          {selecting ? "Done" : "Select"}
        </button>
        {selecting ? (
          <span className="text-quiet text-floor-mute">{picked.length} selected</span>
        ) : null}
      </div>

      {selecting ? (
        <div className="mt-1">
          <p className="text-quiet text-floor-mute">
            F Facebook, E eBay, A Amazon, other letters elsewhere. Filled means listed. Tap a letter to
            mark or unmark the selected units.
          </p>
          <ChannelToggleRow
            options={channelOptions}
            listed={
              picked.length
                ? channelOptions.filter((ch) => !channelNext(ch))
                : []
            }
            disabled={!online}
            onToggle={(channel, next) => void applyListing(channel, next)}
          />
          <EbayBulkEdit
            skus={picked}
            categoryHint={(() => {
              const cats = [...new Set(picked.map((sku) => units?.find((u) => u.sku === sku)?.category || "").filter(Boolean))];
              return cats.length === 1 ? cats[0] : "";
            })()}
          />
        </div>
      ) : null}
        </>
      ) : null}

      <Notice tone="error">{error}</Notice>

      {units === null ? <Spinner label="Reading" /> : null}

      {units?.length === 0 ? (
        <p className="py-6 text-quiet text-floor-mute">
          {query
            ? `Nothing matches “${query}”.`
            : filter === "unfinished"
              ? "Nothing unfinished — every live unit has photos and a price."
              : "Nothing here yet."}
        </p>
      ) : null}

      <ul>
        {units?.map((unit) => {
          const channels = listedMap.get(unit.sku) ?? [];
          return (
            <li key={unit.sku} className="border-b border-floor-line">
              <div className="flex min-h-touch items-center gap-3 py-3">
                {selecting ? (
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={picked.includes(unit.sku)}
                    onChange={() => togglePick(unit.sku)}
                    aria-label={`Select ${unit.sku}`}
                  />
                ) : null}
                <Link
                  to={selecting ? "#" : `/inventory/${unit.sku}`}
                  onClick={(e) => {
                    if (!selecting) return;
                    e.preventDefault();
                    togglePick(unit.sku);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3"
                >
                  <span className="w-14 shrink-0 font-mono text-body text-floor-mute">{unit.sku}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body">
                      {[unit.brand, unit.model].filter(Boolean).join(" ") || unit.title || "Untitled"}
                    </span>
                    <span className="block truncate text-quiet text-floor-mute">
                      {[unit.category, unit.condition, unit.location].filter(Boolean).join(" · ") || "—"}
                    </span>
                    <ChannelMarks channels={channels} />
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-body">{formatCents(unit.askCents) || "—"}</span>
                    {unit.state !== "available" ? (
                      <span className="block text-quiet text-floor-mute">{unit.state}</span>
                    ) : null}
                  </span>
                </Link>
              </div>
            </li>
          );
        })}
      </ul>

      {units?.length ? (
        <p className="py-4 text-quiet text-floor-mute">
          {units.length} {units.length === 1 ? "unit" : "units"}
        </p>
      ) : null}
    </section>
  );
}
