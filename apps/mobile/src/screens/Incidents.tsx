import { useEffect, useState } from "react";
import { floorCloud } from "@floor/cloud";
import { useStore } from "../store";
import { Notice } from "../components/ui";
import { friendlyRpc } from "../rpc";

type Incident = { id: number; kind: string; sku: string | null; detail: unknown; created_at: string };

export function IncidentsScreen() {
  const { session, hydrate } = useStore();
  const [rows, setRows] = useState<Incident[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const { data, error: qErr } = await floorCloud()
      .from("incidents")
      .select("id, kind, sku, detail, created_at")
      .is("resolved_at", null)
      .order("created_at", { ascending: false });
    if (qErr) setError(friendlyRpc(qErr));
    else setRows((data ?? []) as Incident[]);
  }

  useEffect(() => {
    void load();
  }, []);

  async function resolve(id: number) {
    const { error: rpcErr } = await floorCloud().rpc("resolve_incident", { p_id: id });
    if (rpcErr) setError(friendlyRpc(rpcErr));
    await load();
    await hydrate();
  }

  return (
    <section>
      <h1 className="text-title">Incidents</h1>
      <Notice tone="error">{error}</Notice>
      {rows.length === 0 ? <p className="mt-4 text-quiet">None open.</p> : null}
      <ul>
        {rows.map((row) => (
          <li key={row.id} className="border border-floor-danger p-3 my-3">
            <p className="text-body text-floor-danger">
              {row.kind === "double_sell" ? "DOUBLE SALE" : row.kind} · SKU {row.sku}
            </p>
            <p className="text-quiet">{new Date(row.created_at).toLocaleString()}</p>
            {session.role !== "staff" ? (
              <button type="button" className="btn-text px-0 mt-2" onClick={() => void resolve(row.id)}>
                Resolve
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
