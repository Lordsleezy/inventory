import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatCents } from "@floor/store";
import { searchUnits, type CachedUnit } from "../local";
import { usePos } from "../pos-context";
import { useCart } from "../cart";

export function BrowseScreen() {
  const { refreshUnits, online, taxRateBps } = usePos();
  const { lines, addUnit } = useCart();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CachedUnit[]>([]);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => {
      void searchUnits(q).then(setRows);
    }, 80);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <section className="page">
      {taxRateBps == null ? (
        <div className="incident">Set your tax rate in Settings before ringing up sales.</div>
      ) : null}
      <div className="row">
        <input
          className="search"
          placeholder="SKU, title, category"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <button
          type="button"
          disabled={!online}
          onClick={() =>
            void refreshUnits()
              .then(() => searchUnits(q).then(setRows))
              .catch((err) => setError(String(err)))
          }
        >
          Refresh
        </button>
        <button type="button" className="primary" disabled={!lines.length} onClick={() => navigate("/cart")}>
          Cart ({lines.length})
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {flash ? <p>{flash}</p> : null}
      <div className="grid" style={{ marginTop: "1rem" }}>
        {rows.map((u) => {
          const inCart = lines.some((l) => l.sku === u.sku);
          return (
            <div key={u.sku} className="card row">
              <span>
                <strong>{u.sku}</strong>
                <div>{[u.brand, u.model].filter(Boolean).join(" ") || u.title}</div>
                <div className="muted">
                  {u.category || "—"} · {u.condition || "—"}
                </div>
              </span>
              <span className="price">{formatCents(u.askCents) || "—"}</span>
              <button
                type="button"
                className="primary"
                disabled={inCart || taxRateBps == null}
                onClick={() => {
                  addUnit(u);
                  setFlash(`Added ${u.sku}`);
                }}
              >
                {inCart ? "In cart" : "Add"}
              </button>
            </div>
          );
        })}
        {!rows.length ? <p className="muted">No available units in the local snapshot.</p> : null}
      </div>
    </section>
  );
}
