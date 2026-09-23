import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatCents } from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { usePos } from "../pos-context";

type Row = {
  sku: string;
  title: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  condition: string | null;
  ask_cents: number | null;
  state: string;
  acquisition_cost_cents?: number | null;
  floor_cents?: number | null;
};

const LIVE = new Set(["available", "reserved", "repair"]);

export function InventoryScreen() {
  const { session, isAdmin, online } = usePos();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "unfinished">("all");
  const [rows, setRows] = useState<Row[]>([]);
  const [photoSkus, setPhotoSkus] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function load() {
    setError("");
    const sb = floorCloud();
    const cols = isAdmin
      ? "sku, title, brand, model, category, condition, ask_cents, state, acquisition_cost_cents, floor_cents"
      : "sku, title, brand, model, category, condition, ask_cents, state";
    const { data, error: err } = await sb
      .from(isAdmin ? "units" : "units_pos")
      .select(cols)
      .order("sku", { ascending: false })
      .limit(500);
    if (err) {
      setError(err.message);
      return;
    }
    const list = (data ?? []) as unknown as Row[];
    const { data: photoRows } = await sb
      .from("photos")
      .select("sku")
      .in("sku", list.map((u) => u.sku))
      .limit(5000);
    setPhotoSkus(new Set(((photoRows ?? []) as { sku: string }[]).map((p) => p.sku)));
    setRows(list);
  }

  useEffect(() => {
    const t = setTimeout(() => void load(), 120);
    return () => clearTimeout(t);
  }, [isAdmin]);

  const unfinished = useMemo(
    () => rows.filter((u) => LIVE.has(u.state) && (u.ask_cents == null || !photoSkus.has(u.sku))),
    [rows, photoSkus],
  );

  const shown = useMemo(() => {
    const text = q.trim().toLowerCase();
    const base = filter === "unfinished" ? unfinished : rows;
    if (!text) return base;
    return base.filter(
      (u) =>
        u.sku.includes(text) ||
        (u.title || "").toLowerCase().includes(text) ||
        (u.brand || "").toLowerCase().includes(text) ||
        (u.model || "").toLowerCase().includes(text),
    );
  }, [rows, unfinished, filter, q]);

  return (
    <section className="page">
      <div className="row">
        <h1>Inventory</h1>
        {isAdmin ? (
          <button type="button" className="primary" disabled={!online} onClick={() => navigate("/inventory/receive")}>
            Receive
          </button>
        ) : (
          <span className="muted">View only</span>
        )}
      </div>
      <input className="search" placeholder="Search SKU, title, brand…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="row" style={{ marginTop: "0.5rem", gap: "1rem" }}>
        <button type="button" className={filter === "all" ? "primary" : ""} onClick={() => setFilter("all")}>
          All
        </button>
        <button
          type="button"
          className={filter === "unfinished" ? "primary" : ""}
          onClick={() => setFilter("unfinished")}
        >
          Unfinished ({unfinished.length})
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="grid" style={{ marginTop: "1rem" }}>
        {shown.map((u) => (
          <Link key={u.sku} className="card row" to={`/inventory/${u.sku}`} style={{ textDecoration: "none", color: "inherit" }}>
            <span>
              <strong>{u.sku}</strong>
              <div>{[u.brand, u.model].filter(Boolean).join(" ") || u.title}</div>
              <div className="muted">
                {u.state} · {u.category || "—"} · {u.condition || "—"}
              </div>
              {isAdmin && (u.acquisition_cost_cents != null || u.floor_cents != null) ? (
                <div className="muted">
                  Cost {formatCents(u.acquisition_cost_cents ?? null) || "—"} · Floor{" "}
                  {formatCents(u.floor_cents ?? null) || "—"}
                </div>
              ) : null}
            </span>
            <span className="price">{formatCents(u.ask_cents) || "—"}</span>
          </Link>
        ))}
        {!shown.length ? <p className="muted">{filter === "unfinished" ? "Nothing unfinished." : "No units."}</p> : null}
      </div>
      <p className="muted">Signed in as {session.displayName}.</p>
    </section>
  );
}
