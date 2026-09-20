import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { formatCents } from "@floor/store";
import { searchUnits, type CachedUnit } from "../local";
import { usePos } from "../pos-context";

export function BrowseScreen() {
  const { refreshUnits, online } = usePos();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<CachedUnit[]>([]);
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    const t = setTimeout(() => {
      void searchUnits(q).then(setRows);
    }, 80);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <section className="page">
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
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="grid" style={{ marginTop: "1rem" }}>
        {rows.map((u) => (
          <button
            key={u.sku}
            type="button"
            className="card row"
            onClick={() => navigate(`/checkout/${u.sku}`)}
          >
            <span>
              <strong>{u.sku}</strong>
              <div>{[u.brand, u.model].filter(Boolean).join(" ") || u.title}</div>
              <div className="muted">
                {u.category || "—"} · {u.condition || "—"}
              </div>
            </span>
            <span className="price">{formatCents(u.askCents) || "—"}</span>
          </button>
        ))}
        {!rows.length ? <p className="muted">No available units in the local snapshot.</p> : null}
      </div>
    </section>
  );
}
