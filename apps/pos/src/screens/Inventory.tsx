import { useEffect, useState } from "react";
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

export function InventoryScreen() {
  const { session, isAdmin, online } = usePos();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  async function load() {
    setError("");
    const sb = floorCloud();
    if (isAdmin) {
      const { data, error: err } = await sb
        .from("units")
        .select("sku, title, brand, model, category, condition, ask_cents, state, acquisition_cost_cents, floor_cents")
        .order("sku", { ascending: false })
        .limit(500);
      if (err) {
        setError(err.message);
        return;
      }
      let list = (data ?? []) as Row[];
      const text = q.trim().toLowerCase();
      if (text) {
        list = list.filter(
          (u) =>
            u.sku.includes(text) ||
            (u.title || "").toLowerCase().includes(text) ||
            (u.brand || "").toLowerCase().includes(text) ||
            (u.model || "").toLowerCase().includes(text),
        );
      }
      setRows(list);
      return;
    }
    const { data, error: err } = await sb
      .from("units_pos")
      .select("sku, title, brand, model, category, condition, ask_cents, state")
      .order("sku", { ascending: false })
      .limit(500);
    if (err) {
      setError(err.message);
      return;
    }
    let list = (data ?? []) as Row[];
    const text = q.trim().toLowerCase();
    if (text) {
      list = list.filter(
        (u) =>
          u.sku.includes(text) ||
          (u.title || "").toLowerCase().includes(text) ||
          (u.brand || "").toLowerCase().includes(text) ||
          (u.model || "").toLowerCase().includes(text),
      );
    }
    setRows(list);
  }

  useEffect(() => {
    const t = setTimeout(() => void load(), 120);
    return () => clearTimeout(t);
  }, [q, isAdmin]);

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
      {error ? <p className="error">{error}</p> : null}
      <div className="grid" style={{ marginTop: "1rem" }}>
        {rows.map((u) => (
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
        {!rows.length ? <p className="muted">No units.</p> : null}
      </div>
      <p className="muted">Signed in as {session.displayName}.</p>
    </section>
  );
}
