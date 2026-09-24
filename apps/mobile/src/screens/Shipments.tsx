import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { loadUnit } from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { Label, Notice, Spinner } from "../components/ui";
import { authHeader, functionsUrl } from "../functions";
import { friendlyRpc } from "../rpc";
import { useStore } from "../store";

type WebOrder = {
  id: string;
  sku: string;
  status: string;
  buyer_name: string | null;
  buyer_email: string | null;
  ship_line1: string | null;
  ship_line2: string | null;
  ship_city: string | null;
  ship_region: string | null;
  ship_postal: string | null;
  boxed_at: string | null;
  shipped_at: string | null;
  tracking_number: string | null;
  created_at: string;
};

function address(row: WebOrder): string {
  return [
    row.buyer_name,
    row.ship_line1,
    row.ship_line2,
    [row.ship_city, row.ship_region, row.ship_postal].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join("\n");
}

export function ShipmentsScreen() {
  const { db, ensureOnline } = useStore();
  const [rows, setRows] = useState<WebOrder[] | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data, error: qErr } = await floorCloud()
      .from("web_orders")
      .select(
        "id, sku, status, buyer_name, buyer_email, ship_line1, ship_line2, ship_city, ship_region, ship_postal, boxed_at, shipped_at, tracking_number, created_at",
      )
      .eq("status", "paid")
      .order("created_at", { ascending: false })
      .limit(200);
    if (qErr) throw qErr;
    const list = (data ?? []) as WebOrder[];
    setRows(list);
    const next: Record<string, string> = {};
    const track: Record<string, string> = {};
    for (const row of list) {
      const unit = await loadUnit(db, row.sku);
      next[row.sku] = [unit?.brand, unit?.model].filter(Boolean).join(" ") || unit?.title || row.sku;
      track[row.id] = row.tracking_number || "";
    }
    setTitles(next);
    setTracking(track);
  }, [db]);

  useEffect(() => {
    void refresh().catch((err) => setError(friendlyRpc(err)));
  }, [refresh]);

  async function markBoxed(id: string) {
    setError("");
    setBusy(id);
    try {
      await ensureOnline();
      const { error: rpcErr } = await floorCloud().rpc("mark_web_order_boxed", { p_id: id });
      if (rpcErr) throw rpcErr;
      await refresh();
    } catch (err) {
      setError(friendlyRpc(err));
    } finally {
      setBusy(null);
    }
  }

  async function markShipped(id: string) {
    setError("");
    const number = (tracking[id] || "").trim();
    if (!number) {
      setError("Enter a tracking number before marking shipped.");
      return;
    }
    setBusy(id);
    try {
      await ensureOnline();
      const headers = await authHeader();
      const res = await fetch(functionsUrl("web-ship"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ id, tracking: number }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || body.message || "Could not mark shipped.");
      await refresh();
    } catch (err) {
      setError(friendlyRpc(err));
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) return <Spinner label="Loading shipments" />;

  const neu = rows.filter((r) => !r.boxed_at && !r.shipped_at);
  const awaiting = rows.filter((r) => r.boxed_at && !r.shipped_at);
  const past = rows.filter((r) => r.shipped_at);

  return (
    <section>
      <h1 className="text-title">Shipments</h1>
      <Notice tone="error">{error}</Notice>

      <Section title="New Shipments" empty="No paid orders waiting to be boxed.">
        {neu.map((row) => (
          <article key={row.id} className="border-b border-floor-line py-3">
            <ItemHead sku={row.sku} title={titles[row.sku]} />
            <pre className="mt-1 whitespace-pre-wrap font-sans text-quiet text-floor-mute">{address(row) || "No address on file"}</pre>
            <label className="mt-2 flex min-h-touch items-center gap-2">
              <input
                type="checkbox"
                checked={false}
                disabled={busy === row.id}
                onChange={() => void markBoxed(row.id)}
              />
              <span className="text-body">Boxed</span>
            </label>
          </article>
        ))}
      </Section>

      <Section title="Awaiting Shipping" empty="Nothing boxed and waiting to ship.">
        {awaiting.map((row) => (
          <article key={row.id} className="border-b border-floor-line py-3">
            <ItemHead sku={row.sku} title={titles[row.sku]} />
            <pre className="mt-1 whitespace-pre-wrap font-sans text-quiet text-floor-mute">{address(row) || "No address on file"}</pre>
            <label className="mt-2 block">
              <Label>Tracking number</Label>
              <input
                className="field mt-1"
                value={tracking[row.id] ?? ""}
                onChange={(e) => setTracking((prev) => ({ ...prev, [row.id]: e.target.value }))}
              />
            </label>
            <label className="mt-2 flex min-h-touch items-center gap-2">
              <input
                type="checkbox"
                checked={false}
                disabled={busy === row.id}
                onChange={() => void markShipped(row.id)}
              />
              <span className="text-body">Shipped</span>
            </label>
          </article>
        ))}
      </Section>

      <Section title="Past Shipments" empty="Nothing shipped yet.">
        {past.map((row) => (
          <article key={row.id} className="border-b border-floor-line py-3">
            <ItemHead sku={row.sku} title={titles[row.sku]} />
            <p className="mt-1 text-quiet text-floor-mute">Tracking {row.tracking_number || "—"}</p>
            <p className="text-quiet text-floor-mute">
              {row.shipped_at ? new Date(row.shipped_at).toLocaleString("en-US") : ""}
            </p>
          </article>
        ))}
      </Section>
    </section>
  );
}

function ItemHead({ sku, title }: { sku: string; title?: string }) {
  return (
    <p className="text-body">
      <Link to={`/inventory/${sku}`} className="font-mono text-floor-accent">
        {sku}
      </Link>
      {title && title !== sku ? ` · ${title}` : ""}
    </p>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const list = Array.isArray(children) ? children : [children];
  const has = list.filter(Boolean).length > 0;
  return (
    <div className="mt-6">
      <h2 className="text-body">{title}</h2>
      {has ? children : <p className="mt-2 text-quiet text-floor-mute">{empty}</p>}
    </div>
  );
}
