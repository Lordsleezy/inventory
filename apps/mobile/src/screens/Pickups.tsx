import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { floorCloud } from "@floor/cloud";
import { Notice, Spinner } from "../components/ui";
import { friendlyRpc } from "../rpc";
import { useStore } from "../store";

type Pickup = {
  id: string;
  order_no: string | null;
  sku: string;
  title: string;
  buyer_name: string | null;
  buyer_phone: string | null;
  buyer_email: string | null;
  total_cents: number;
  paid_at: string | null;
  pickup_deadline: string | null;
  picked_up_at: string | null;
  picked_up_by: string | null;
  status: "awaiting" | "picked_up" | "canceling";
};

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const when = (s: string) =>
  new Date(s).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function timeLeft(deadline: string | null, now: number) {
  if (!deadline) return "";
  const ms = new Date(deadline).getTime() - now;
  if (ms <= 0) return "Deadline passed";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h ${m}m left`;
}

/** Paid website orders waiting for in-store pickup. Hand over after checking name + order number. */
export function PickupsScreen() {
  const { ensureOnline } = useStore();
  const [rows, setRows] = useState<Pickup[] | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    const { data, error: rpcErr } = await floorCloud().rpc("open_pickup_orders");
    if (rpcErr) throw rpcErr;
    setRows((data ?? []) as Pickup[]);
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError(friendlyRpc(err)));
    const t = setInterval(() => {
      setNow(Date.now());
      void refresh().catch(() => undefined);
    }, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  async function handOver(id: string) {
    setError("");
    setBusy(true);
    try {
      await ensureOnline();
      const { error: rpcErr } = await floorCloud().rpc("mark_pickup_complete", { p_order: id });
      if (rpcErr) throw rpcErr;
      setConfirming(null);
      await refresh();
    } catch (err) {
      setError(friendlyRpc(err));
    } finally {
      setBusy(false);
    }
  }

  if (rows === null) return error ? <Notice tone="error">{error}</Notice> : <Spinner label="Loading pickups" />;
  const waiting = rows.filter((r) => r.status !== "picked_up");
  const done = rows.filter((r) => r.status === "picked_up");

  return (
    <section>
      <h1 className="text-title">Pickups</h1>
      <p className="mt-1 text-quiet text-floor-mute">Paid online. Check the customer’s name and order number before handing over.</p>
      <Notice tone="error">{error}</Notice>

      <h2 className="mt-6 text-body">Waiting ({waiting.length})</h2>
      {waiting.length === 0 ? <p className="mt-2 text-quiet text-floor-mute">No pickups waiting.</p> : null}
      {waiting.map((r) => (
        <article key={r.id} className="border-b border-floor-line py-3">
          <p className="text-body">
            <span className="font-mono">{r.order_no}</span> · {r.buyer_name}
          </p>
          <p className="text-body">
            <Link to={`/inventory/${r.sku}`} className="font-mono text-floor-accent">{r.sku}</Link> · {r.title}
          </p>
          <p className="text-quiet text-floor-mute">
            {money(r.total_cents)} paid · {r.buyer_phone}
          </p>
          <p className={`text-quiet ${r.pickup_deadline && new Date(r.pickup_deadline).getTime() - now < 86400000 ? "text-floor-danger" : "text-floor-mute"}`}>
            Pick up by {r.pickup_deadline ? when(r.pickup_deadline) : "—"} · {timeLeft(r.pickup_deadline, now)}
          </p>
          {r.status === "canceling" ? (
            <p className="mt-2 text-quiet text-floor-mute">Being canceled and refunded.</p>
          ) : confirming === r.id ? (
            <div className="mt-2 border border-floor-line p-3">
              <p className="text-body">Hand over to {r.buyer_name}, order {r.order_no}?</p>
              <div className="mt-2 flex gap-2">
                <button className="btn-accent" disabled={busy} onClick={() => void handOver(r.id)}>
                  {busy ? "Saving…" : "Yes, picked up"}
                </button>
                <button className="btn-text" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn-accent mt-2" onClick={() => setConfirming(r.id)}>Picked up</button>
          )}
        </article>
      ))}

      {done.length ? <h2 className="mt-6 text-body">Picked up recently</h2> : null}
      {done.map((r) => (
        <article key={r.id} className="border-b border-floor-line py-3">
          <p className="text-body"><span className="font-mono">{r.order_no}</span> · {r.buyer_name} · {r.title}</p>
          <p className="text-quiet text-floor-mute">Picked up {r.picked_up_at ? when(r.picked_up_at) : ""}{r.picked_up_by ? ` · ${r.picked_up_by}` : ""}</p>
        </article>
      ))}
    </section>
  );
}
