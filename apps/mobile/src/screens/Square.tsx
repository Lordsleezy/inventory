import { useEffect, useState } from "react";
import { App as CapApp } from "@capacitor/app";
import { formatCents } from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { openConnectUrl } from "../oauth-browser";
import { authHeader, functionsUrl } from "../functions";
import { useStore } from "../store";
import { Label, Notice, Spinner } from "../components/ui";
import { friendlyRpc } from "../rpc";
import { PaymentDeviceScreen } from "./PaymentDevice";

type Conn = {
  provider: string;
  status: string;
  account_label: string | null;
  last_error: string | null;
  location_id: string | null;
};

type Charge = {
  id: string;
  sku: string | null;
  title: string | null;
  amount_cents: number;
  tax_cents: number;
  status: string;
  card_brand: string | null;
  card_last4: string | null;
  created_at: string;
};

export function SquareScreen() {
  const { session, hydrate, cardPayments } = useStore();
  const owner = session.role === "owner";
  const [conn, setConn] = useState<Conn | null>(null);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [charges, setCharges] = useState<Charge[] | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const { data, error: rpcErr } = await floorCloud().rpc("my_connection_status");
      if (rpcErr) throw rpcErr;
      setConn(((data ?? []) as Conn[]).find((r) => r.provider === "square") ?? null);
      const { data: rows } = await floorCloud()
        .from("card_charges")
        .select("id, sku, title, amount_cents, tax_cents, status, card_brand, card_last4, created_at")
        .neq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(15);
      setCharges((rows as Charge[] | null) ?? []);
    } catch (err) {
      setError(friendlyRpc(err));
    }
  }

  useEffect(() => {
    void load();
    const sub = CapApp.addListener("appUrlOpen", () => {
      void load();
      void hydrate();
    });
    return () => {
      void sub.then((h) => h.remove());
    };
  }, [hydrate]);

  async function connect() {
    setError("");
    try {
      const headers = await authHeader();
      const res = await fetch(functionsUrl("oauth-start?provider=square"), { headers });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.url) {
        setError(
          `Connect Square failed (HTTP ${res.status}): ${body.message || body.error || "no authorize URL"}`,
        );
        return;
      }
      await openConnectUrl(body.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/cancelled/i.test(message)) return;
      setError(`Connect Square failed: ${friendlyRpc(err)}`);
    }
  }

  async function disconnect() {
    const { error: rpcErr } = await floorCloud().rpc("disconnect_provider", { p_provider: "square" });
    if (rpcErr) setError(`Disconnect failed: ${friendlyRpc(rpcErr)}`);
    await load();
    await hydrate();
  }

  async function loadLocations() {
    setError("");
    try {
      const headers = await authHeader();
      const res = await fetch(functionsUrl("square-locations"), { headers });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(`Square locations failed (HTTP ${res.status}): ${body.error || body.message || "unknown"}`);
        return;
      }
      setLocations(body.locations || []);
      if (!(body.locations || []).length) setError("Square returned no locations for this account.");
    } catch (err) {
      setError(`Square locations failed: ${friendlyRpc(err)}`);
    }
  }

  async function pickLocation(id: string, name: string) {
    setError("");
    try {
      const headers = await authHeader();
      const res = await fetch(functionsUrl("square-set-location"), {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ locationId: id, name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(`Set Square location failed (HTTP ${res.status}): ${body.error || "unknown"}`);
        return;
      }
      setLocations([]);
      await load();
    } catch (err) {
      setError(`Set Square location failed: ${friendlyRpc(err)}`);
    }
  }

  const connected = conn?.status === "connected";

  return (
    <section>
      <h1 className="text-title">Square</h1>
      <Notice tone="error">{error}</Notice>

      <div className="border-b border-floor-line py-3">
        <p className="text-body">Square account</p>
        <p className="text-quiet text-floor-mute">
          {conn?.status || "disconnected"}
          {conn?.account_label ? ` · ${conn.account_label}` : ""}
          {conn?.location_id ? ` · location ${conn.location_id}` : ""}
          {conn?.last_error ? ` · ${conn.last_error}` : ""}
          {` · card payments ${cardPayments ? "on" : "off"}`}
        </p>
        {owner ? (
          <div className="mt-2 flex flex-wrap gap-3">
            <button type="button" className="btn-accent" onClick={() => void connect()}>
              {connected ? "Reconnect" : "Connect"}
            </button>
            {connected ? (
              <button type="button" className="btn-text px-0" onClick={() => void disconnect()}>
                Disconnect
              </button>
            ) : null}
            {connected ? (
              <button type="button" className="btn-text px-0" onClick={() => void loadLocations()}>
                Pick location
              </button>
            ) : null}
          </div>
        ) : (
          <p className="mt-1 text-quiet text-floor-mute">Only the owner can connect or pick a location.</p>
        )}
        {locations.length ? (
          <ul className="mt-2">
            {locations.map((loc) => (
              <li key={loc.id}>
                <button type="button" className="btn-text px-0" onClick={() => void pickLocation(loc.id, loc.name)}>
                  {loc.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="mt-6">
        <PaymentDeviceScreen />
      </div>

      <div className="mt-6">
        <Label>Recent card payments</Label>
        {charges === null ? <Spinner label="Loading payments" /> : null}
        {charges?.length === 0 ? <p className="mt-2 text-quiet text-floor-mute">No card payments yet.</p> : null}
        <ul className="mt-2">
          {charges?.map((c) => (
            <li key={c.id} className="flex items-baseline justify-between gap-3 border-b border-floor-line py-2">
              <span className="min-w-0">
                <span className="block truncate text-body">{c.title || c.sku || "Card charge"}</span>
                <span className="text-quiet text-floor-mute">
                  {c.status}
                  {c.card_brand ? ` · ${c.card_brand}` : ""}
                  {c.card_last4 ? ` ··${c.card_last4}` : ""}
                  {` · ${new Date(c.created_at).toLocaleString("en-US")}`}
                </span>
              </span>
              <span className="shrink-0">{formatCents(c.amount_cents)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
