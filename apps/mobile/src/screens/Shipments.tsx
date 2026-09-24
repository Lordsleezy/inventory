import { useCallback, useEffect, useState } from "react";
import { floorCloud } from "@floor/cloud";
import { formatCents } from "@floor/store";
import { Label, Notice } from "../components/ui";
import { useStore } from "../store";
import { friendlyRpc } from "../rpc";

type WebOrder = {
  id: string;
  sku: string;
  status: string;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  ship_line1: string | null;
  ship_line2: string | null;
  ship_city: string | null;
  ship_region: string | null;
  ship_postal: string | null;
  item_cents: number;
  shipping_cents: number;
  total_cents: number;
  boxed_at: string | null;
  shipped_at: string | null;
  tracking_number: string | null;
  created_at: string;
};

function address(row: WebOrder): string {
  return [row.ship_line1, row.ship_line2, [row.ship_city, row.ship_region, row.ship_postal].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join("\n");
}

export function ShipmentsScreen() {
  const { ensureOnline } = useStore();
  const [rows, setRows] = useState<WebOrder[]>([]);
  const [error, setError] = useState("");
  const [tracking, setTracking] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data, error: qErr } = await floorCloud()
      .from("web_orders")
      .select("*")
      .eq("status", "paid")
      .order("created_at", { ascending: false });
    if (qErr) throw qErr;
    setRows((data ?? []) as WebOrder[]);
  }, []);

  useEffect(() => {
    void load().catch((err) => setError(friendlyRpc(err)));
  }, [load]);

  async function boxed(id: string) {
    setError("");
    try {
      await ensureOnline();
      const { error: rpcErr } = await floorCloud().rpc("mark_web_order_boxed", { p_id: id });
      if (rpcErr) throw rpcErr;
      await load();
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  async function shipped(id: string) {
    setError("");
    const number = (tracking[id] || "").trim();
    if (!number) {
      setError("Enter a tracking number first.");
      return;
    }
    try {
      await ensureOnline();
      const { error: rpcErr } = await floorCloud().rpc("mark_web_order_shipped", {
        p_id: id,
        p_tracking: number,
      });
      if (rpcErr) throw rpcErr;
      await load();
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  const fresh = rows.filter((r) => !r.boxed_at);
  const awaiting = rows.filter((r) => r.boxed_at && !r.shipped_at);
  const past = rows.filter((r) => r.shipped_at);

  return (
    <section>
      <h1 className="text-title">Shipments</h1>
      <Notice tone="error">{error}</Notice>

      <Section title="New Shipments" empty="No unpaid-packing orders.">
        {fresh.map((row) => (
          <article key={row.id} className="border-b border-floor-line py-3">
            <OrderHead row={row} />
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" onChange={() => void boxed(row.id)} />
              <span className="text-body">Boxed</span>
            </label>
          </article>
        ))}
      </Section>

      <Section title="Awaiting Shipping" empty="Nothing waiting on a label.">
        {awaiting.map((row) => (
          <article key={row.id} className="border-b border-floor-line py-3">
            <OrderHead row={row} />
            <label className="mt-2 block">
              <Label>Tracking number</Label>
              <input
                className="field mt-1"
                value={tracking[row.id] ?? row.tracking_number ?? ""}
                onChange={(e) => setTracking((cur) => ({ ...cur, [row.id]: e.target.value }))}
              />
            </label>
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" onChange={() => void shipped(row.id)} />
              <span className="text-body">Shipped</span>
            </label>
          </article>
        ))}
      </Section>

      <Section title="Past Shipments" empty="None shipped yet.">
        {past.map((row) => (
          <article key={row.id} className="border-b border-floor-line py-3">
            <OrderHead row={row} />
            <p className="mt-1 text-quiet">Tracking {row.tracking_number}</p>
          </article>
        ))}
      </Section>
    </section>
  );
}

function OrderHead({ row }: { row: WebOrder }) {
  return (
    <>
      <p className="font-mono text-body">{row.sku}</p>
      <p className="text-quiet">
        {formatCents(row.item_cents)} + ship {formatCents(row.shipping_cents)} = {formatCents(row.total_cents)}
      </p>
      <p className="mt-1 text-body">{row.buyer_name || "Buyer"}</p>
      <p className="text-quiet whitespace-pre-wrap">{address(row) || "No address"}</p>
      {row.buyer_email ? <p className="text-quiet">{row.buyer_email}</p> : null}
      {row.buyer_phone ? <p className="text-quiet">{row.buyer_phone}</p> : null}
    </>
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
  const has = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="mt-5">
      <h2 className="text-body">{title}</h2>
      {has ? children : <p className="mt-2 text-quiet text-floor-mute">{empty}</p>}
    </div>
  );
}
