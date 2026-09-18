import { useEffect, useState } from "react";
import { App as CapApp } from "@capacitor/app";
import { openConnectUrl } from "../oauth-browser";
import { floorCloud } from "@floor/cloud";
import { useStore } from "../store";
import { authHeader, functionsUrl } from "../functions";
import { Notice } from "../components/ui";
import { friendlyRpc } from "../rpc";

type Conn = {
  provider: string;
  status: string;
  account_label: string | null;
  last_error: string | null;
  expires_at: string | null;
  reauthorize_after: string | null;
  location_id: string | null;
};

export function ConnectionsScreen() {
  const { session, hydrate, cardPayments } = useStore();
  const [rows, setRows] = useState<Conn[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [amazonPro, setAmazonPro] = useState(false);

  async function load() {
    const { data, error: rpcErr } = await floorCloud().rpc("my_connection_status");
    if (rpcErr) setError(friendlyRpc(rpcErr));
    else setRows((data ?? []) as Conn[]);
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

  if (session.role !== "owner") {
    return <p className="text-quiet">Only the store owner can manage Connections.</p>;
  }

  async function connectFetch(provider: string) {
    setError("");
    try {
      const headers = await authHeader();
      const res = await fetch(functionsUrl(`oauth-start?provider=${provider}`), { headers });
      const body = await res.json().catch(() => ({}));
      if (res.status === 403) {
        setError(body.message || "Only the store owner can connect, and the marketplace account owner must authorize.");
        return;
      }
      if (!res.ok || !body.url) {
        setError(body.message || body.error || `Connect failed (${res.status})`);
        return;
      }
      const mode = await openConnectUrl(body.url);
      if (mode === "native") {
        await load();
        await hydrate();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "cancelled" || /cancelled/i.test(message)) return;
      setError(friendlyRpc(err));
    }
  }

  async function disconnect(provider: string) {
    const { error: rpcErr } = await floorCloud().rpc("disconnect_provider", { p_provider: provider });
    if (rpcErr) setError(friendlyRpc(rpcErr));
    await load();
    await hydrate();
  }

  async function loadLocations() {
    const headers = await authHeader();
    const res = await fetch(functionsUrl("square-locations"), { headers });
    const body = await res.json();
    if (!res.ok) setError(body.error || "locations failed");
    else setLocations(body.locations || []);
  }

  async function pickLocation(id: string, name: string) {
    const headers = await authHeader();
    await fetch(functionsUrl("square-set-location"), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ locationId: id, name }),
    });
    await load();
  }

  const by = (p: string) => rows.find((r) => r.provider === p);

  return (
    <section>
      <h1 className="text-title">Connections</h1>
      <p className="text-quiet text-floor-mute">
        Square turns on card payments. It does not change eBay/Amazon/website modes.
      </p>
      <Notice tone="error">{error}</Notice>
      <Card
        title="Square"
        row={by("square")}
        extra={cardPayments ? "Card payments on" : "Card payments off"}
        onConnect={() => void connectFetch("square")}
        onDisconnect={() => void disconnect("square")}
        onLocations={loadLocations}
        locations={locations}
        onPick={pickLocation}
      />
      <Card title="eBay" row={by("ebay")} extra="Sandbox until EBAY_ENV is production" onConnect={() => void connectFetch("ebay")} onDisconnect={() => void disconnect("ebay")} />
      <div className="border-b border-floor-line py-3">
        <p className="text-body">Amazon</p>
        <label className="mt-2 flex items-center gap-2 text-quiet">
          <input type="checkbox" checked={amazonPro} onChange={(e) => setAmazonPro(e.target.checked)} />
          Professional seller account
        </label>
        {!amazonPro ? (
          <p className="mt-2 text-quiet text-floor-mute">
            Individual accounts stay manual — no Connect. Mark listings on the unit screen.
          </p>
        ) : (
          <Card
            title="Amazon SP-API"
            row={by("amazon")}
            onConnect={() => void connectFetch("amazon")}
            onDisconnect={() => void disconnect("amazon")}
            nested
          />
        )}
      </div>
    </section>
  );
}

function Card({
  title,
  row,
  extra,
  onConnect,
  onDisconnect,
  onLocations,
  locations,
  onPick,
  nested,
}: {
  title: string;
  row?: Conn;
  extra?: string;
  onConnect: () => void;
  onDisconnect: () => void;
  onLocations?: () => Promise<void>;
  locations?: { id: string; name: string }[];
  onPick?: (id: string, name: string) => Promise<void>;
  nested?: boolean;
}) {
  const status = row?.status || "disconnected";
  return (
    <div className={`${nested ? "" : "border-b border-floor-line"} py-3`}>
      <p className="text-body">{title}</p>
      <p className="text-quiet text-floor-mute">
        {status}
        {row?.account_label ? ` · ${row.account_label}` : ""}
        {row?.last_error ? ` · ${row.last_error}` : ""}
        {extra ? ` · ${extra}` : ""}
      </p>
      <div className="mt-2 flex flex-wrap gap-3">
        <button type="button" className="btn-accent" onClick={onConnect}>
          Connect
        </button>
        {status === "connected" ? (
          <button type="button" className="btn-text px-0" onClick={onDisconnect}>
            Disconnect
          </button>
        ) : null}
        {onLocations && status === "connected" ? (
          <button type="button" className="btn-text px-0" onClick={() => void onLocations()}>
            Pick location
          </button>
        ) : null}
      </div>
      {locations?.length ? (
        <ul className="mt-2">
          {locations.map((loc) => (
            <li key={loc.id}>
              <button type="button" className="btn-text px-0" onClick={() => void onPick?.(loc.id, loc.name)}>
                {loc.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

