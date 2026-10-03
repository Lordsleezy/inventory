import { useCallback, useEffect, useState } from "react";
import { authErrorMessage, floorCloud } from "@floor/cloud";

type Pickup = {
  id: string;
  order_no: string | null;
  sku: string;
  title: string;
  buyer_name: string | null;
  buyer_phone: string | null;
  total_cents: number;
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
  if (ms <= 0) return "deadline passed";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h left` : `${h}h ${m}m left`;
}

/** Website orders paid online and waiting for in-store pickup. */
export function PickupsScreen() {
  const [rows, setRows] = useState<Pickup[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [confirming, setConfirming] = useState<Pickup | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const { data, error: rpcErr } = await floorCloud().rpc("open_pickup_orders");
    if (rpcErr) throw rpcErr;
    setRows((data ?? []) as Pickup[]);
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(authErrorMessage(err)));
    const t = setInterval(() => {
      setNow(Date.now());
      void load().catch(() => undefined);
    }, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function handOver(p: Pickup) {
    setBusy(true);
    setError("");
    try {
      const { error: rpcErr } = await floorCloud().rpc("mark_pickup_complete", { p_order: p.id });
      if (rpcErr) throw rpcErr;
      setConfirming(null);
      await load();
    } catch (err) {
      const msg = authErrorMessage(err);
      setError(/pickup_not_open/.test(msg) ? "That pickup was already handed over or canceled." : msg);
    } finally {
      setBusy(false);
    }
  }

  const q = query.trim().toLowerCase();
  const match = (p: Pickup) => !q || [p.order_no, p.buyer_name, p.buyer_phone, p.sku].some((v) => String(v || "").toLowerCase().includes(q));
  const waiting = (rows || []).filter((p) => p.status !== "picked_up" && match(p));
  const done = (rows || []).filter((p) => p.status === "picked_up" && match(p));

  return (
    <section className="page">
      <h1>Online pickups</h1>
      <p className="muted">Paid on the website. Check the customer’s name and order number, then mark it picked up.</p>
      <div className="row">
        <input className="search" placeholder="Order #, name, phone or SKU" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error ? <p className="error">{error}</p> : null}
      {rows === null ? <p className="muted">Loading…</p> : null}
      {rows && !waiting.length ? <p className="muted">No pickups waiting.</p> : null}
      <div className="grid" style={{ marginTop: "1rem" }}>
        {waiting.map((p) => (
          <div key={p.id} className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{p.order_no} · {p.buyer_name}</strong>
              <span className="price">{money(p.total_cents)} paid</span>
            </div>
            <div>SKU {p.sku} · {p.title}</div>
            <div className="muted">{p.buyer_phone}</div>
            <div className={p.pickup_deadline && new Date(p.pickup_deadline).getTime() - now < 86400000 ? "error" : "muted"}>
              Pick up by {p.pickup_deadline ? when(p.pickup_deadline) : "—"} · {timeLeft(p.pickup_deadline, now)}
            </div>
            {p.status === "canceling" ? (
              <div className="muted">Being canceled and refunded.</div>
            ) : (
              <button type="button" className="primary" style={{ marginTop: "0.5rem" }} onClick={() => setConfirming(p)}>Picked up</button>
            )}
          </div>
        ))}
      </div>
      {done.length ? <h2 style={{ marginTop: "1.5rem" }}>Picked up recently</h2> : null}
      {done.map((p) => (
        <div key={p.id} className="muted">
          {p.order_no} · {p.buyer_name} · SKU {p.sku} · {p.picked_up_at ? when(p.picked_up_at) : ""}{p.picked_up_by ? ` · ${p.picked_up_by}` : ""}
        </div>
      ))}
      {confirming ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="card">
            <h2>Hand over order {confirming.order_no}?</h2>
            <p>Customer: <strong>{confirming.buyer_name}</strong></p>
            <p>SKU {confirming.sku} · {confirming.title}</p>
            <p className="muted">Ask for the name and order number before handing it over.</p>
            <div className="row">
              <button type="button" className="primary" disabled={busy} onClick={() => void handOver(confirming)}>
                {busy ? "Saving…" : "Yes, picked up"}
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
