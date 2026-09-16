import { useEffect, useState } from "react";
import { floorCloud } from "@floor/cloud";
import { MANUAL_INSTRUCTIONS } from "@floor/channels";
import { useStore } from "../store";
import { Notice } from "../components/ui";

type Task = {
  id: number;
  sku: string;
  channel: string;
  nag_after: string;
  created_at: string;
};

export function DelistScreen() {
  const { hydrate, online } = useStore();
  const [rows, setRows] = useState<Task[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const { data, error: qErr } = await floorCloud()
      .from("delist_tasks")
      .select("id, sku, channel, nag_after, created_at")
      .is("completed_at", null)
      .order("created_at");
    if (qErr) setError(qErr.message);
    else setRows((data ?? []) as Task[]);
  }

  useEffect(() => {
    void load();
  }, []);

  async function done(id: number) {
    setError("");
    const { error: rpcErr } = await floorCloud().rpc("complete_delist_task", { p_id: id });
    if (rpcErr) setError(rpcErr.message);
    await load();
    await hydrate();
  }

  return (
    <section>
      <h1 className="text-title">Delist</h1>
      <p className="text-quiet text-floor-mute">Check off each channel after you take the listing down.</p>
      <Notice tone="error">{error}</Notice>
      {rows.length === 0 ? <p className="mt-4 text-quiet">Nothing waiting.</p> : null}
      <ul>
        {rows.map((row) => {
          const overdue = new Date(row.nag_after).getTime() < Date.now();
          return (
            <li key={row.id} className="border-b border-floor-line py-3">
              <p className="text-body">
                SKU {row.sku} · {row.channel}
                {overdue ? <span className="text-floor-danger"> · overdue</span> : null}
              </p>
              <p className="text-quiet text-floor-mute">{MANUAL_INSTRUCTIONS[row.channel] ?? "Take the listing down."}</p>
              <button type="button" className="btn-text px-0" disabled={!online} onClick={() => void done(row.id)}>
                I took it down
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
