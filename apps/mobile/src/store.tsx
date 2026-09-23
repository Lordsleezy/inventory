import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { initDb, loadSettings, type Db, type Settings } from "@floor/store";
import {
  authErrorMessage,
  applyCachePayload,
  floorCloud,
  loadStaffSession,
  OfflineError,
  probeFunctions,
  probeSupabase,
  readDeviceNetwork,
  type Connectivity,
  type StaffSession,
} from "@floor/cloud";
import { installDeviceNetwork, listenConnectivity } from "./connectivity";

installDeviceNetwork();

const functionsUrl = import.meta.env.VITE_FUNCTIONS_URL;

type StoreValue = {
  db: Db;
  settings: Settings;
  session: StaffSession;
  online: boolean;
  connectionType: string;
  supabaseReach: string;
  functionsReach: string;
  cloudError: string;
  delistCount: number;
  incidentCount: number;
  cardPayments: boolean;
  cacheEpoch: number;
  hydrate: () => Promise<void>;
  refreshConnectivity: () => Promise<Connectivity>;
  ensureOnline: () => Promise<void>;
  setSetting: (key: string, value: unknown) => Promise<void>;
  reloadSettings: () => Promise<void>;
};

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useStore used outside StoreProvider");
  return value;
}

export function useDb(): Db {
  return useStore().db;
}

let booting: Promise<Db> | null = null;

function boot(): Promise<Db> {
  if (!booting) {
    booting = (async () => {
      const db =
        Capacitor.getPlatform() === "web"
          ? await (await import("./driver-web")).openWebDb()
          : await (await import("@floor/store/capacitor")).openCapacitorDb();
      await initDb(db);
      return db;
    })().catch((err) => {
      booting = null;
      throw err;
    });
  }
  return booting;
}

async function settingsFromCloud(session: StaffSession): Promise<Partial<Settings> & { cardPayments: boolean; displayName: string }> {
  const sb = floorCloud();
  const { data } = await sb.from("store_settings").select("key, value").eq("store_id", session.storeId);
  const map = new Map((data ?? []).map((row) => [row.key, row.value]));
  const readList = (key: string, fallback: string[]): string[] => {
    const v = map.get(key);
    return Array.isArray(v) ? v.map(String) : fallback;
  };
  const num = (key: string, fallback: number) => {
    const v = map.get(key);
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    displayName: String(map.get("display_name") ?? "Store"),
    storeName: String(map.get("display_name") ?? "Store"),
    skuStart: num("skuStart", 10000),
    skuDigits: num("skuDigits", 5),
    taxRateBps: num("taxRateBps", 0),
    currency: String(map.get("currency") ?? "USD").replace(/"/g, ""),
    categories: readList("categories", ["Uncategorized"]),
    conditions: readList("conditions", ["New", "Open box", "Excellent", "Good", "Fair", "For parts"]),
    testStatuses: readList("testStatuses", ["untested", "passed", "failed", "partial"]),
    locations: readList("locations", ["Floor", "Back room", "Repair bench"]),
    channels: readList("channels", ["floor", "ebay", "facebook", "offerup", "amazon", "tiktok", "website"]),
    paymentMethods: readList("paymentMethods", ["cash", "card", "split", "other"]),
    cardPayments: map.get("card_payments_enabled") === true || map.get("card_payments_enabled") === "true",
    cardFeeBps: num("card_fee_bps", 250),
  };
}

async function hydrateCache(db: Db, session: StaffSession): Promise<{ delist: number; incidents: number }> {
  const sb = floorCloud();
  const staffView = session.role === "staff";
  const [ledger, units, sales, photos, events, listings, delist, incidents] = await Promise.all([
    sb.from("sku_ledger").select("sku, issued_at, label, fate"),
    staffView ? sb.from("units_pos").select("*") : sb.from("units").select("*"),
    sb.from("sales").select("*"),
    sb.from("photos").select("*"),
    sb.from("events").select("id, at, sku, kind, field, old_value, new_value, actor, note"),
    sb.from("listings").select("sku, channel, status, listing_id, listed_at, delisted_at"),
    sb.from("delist_tasks").select("id", { count: "exact", head: true }).is("completed_at", null),
    sb.from("incidents").select("id", { count: "exact", head: true }).is("resolved_at", null),
  ]);
  for (const result of [ledger, units, sales, photos, events, listings]) {
    if (result.error) throw new Error(result.error.message);
  }

  await applyCachePayload(db, {
    includeCost: !staffView,
    ledger: (ledger.data ?? []) as Array<Record<string, unknown>>,
    units: (units.data ?? []) as Array<Record<string, unknown>>,
    sales: (sales.data ?? []) as Array<Record<string, unknown>>,
    photos: (photos.data ?? []) as Array<Record<string, unknown>>,
    events: (events.data ?? []) as Array<Record<string, unknown>>,
    listings: (listings.data ?? []) as Array<Record<string, unknown>>,
  });

  return { delist: delist.count ?? 0, incidents: incidents.count ?? 0 };
}

export function StoreProvider({ session, children }: { session: StaffSession; children: React.ReactNode }) {
  const [db, setDb] = useState<Db | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [online, setOnline] = useState(true);
  const [connectionType, setConnectionType] = useState("unknown");
  const [supabaseReach, setSupabaseReach] = useState("…");
  const [functionsReach, setFunctionsReach] = useState("…");
  const [cloudError, setCloudError] = useState("");
  const [delistCount, setDelistCount] = useState(0);
  const [incidentCount, setIncidentCount] = useState(0);
  const [cardPayments, setCardPayments] = useState(false);
  const [cacheEpoch, setCacheEpoch] = useState(0);
  const [error, setError] = useState("");

  const refreshConnectivity = useCallback(async () => {
    const net = await readDeviceNetwork();
    setOnline(net.connected);
    setConnectionType(net.connectionType);
    if (!net.connected) {
      setSupabaseReach("device offline");
      setFunctionsReach("device offline");
      return {
        connected: false,
        connectionType: net.connectionType,
        supabase: { ok: false, detail: "device offline" },
        functions: { ok: false, detail: "device offline" },
      } satisfies Connectivity;
    }
    const supabase = await probeSupabase();
    setSupabaseReach(supabase.ok ? "ok" : supabase.detail);
    setCloudError(supabase.ok ? "" : supabase.detail);
    void probeFunctions(functionsUrl).then((functions) => {
      setFunctionsReach(functions.ok ? "ok" : functions.detail);
    });
    return {
      connected: true,
      connectionType: net.connectionType,
      supabase,
      functions: { ok: true, detail: "checking" },
    } satisfies Connectivity;
  }, []);

  const ensureOnline = useCallback(async () => {
    const status = await refreshConnectivity();
    if (!status.connected) throw new OfflineError();
    if (!status.supabase.ok) throw new Error(status.supabase.detail);
  }, [refreshConnectivity]);

  const hydrate = useCallback(async () => {
    if (!db) return;
    const status = await refreshConnectivity();
    if (!status.connected) return;
    try {
      const cloudSettings = await settingsFromCloud(session);
      await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
        "storeName",
        JSON.stringify(cloudSettings.storeName),
      ]);
      setSettings((prev) => ({ ...(prev as Settings), ...cloudSettings }));
      setCardPayments(cloudSettings.cardPayments);
      const counts = await Promise.race([
        hydrateCache(db, session),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Cache refresh timed out. Check your connection and try again.")), 20_000),
        ),
      ]);
      setDelistCount(counts.delist);
      setIncidentCount(counts.incidents);
      setCacheEpoch((n) => n + 1);
      if (!status.supabase.ok) setCloudError(status.supabase.detail);
      else setCloudError("");
    } catch (err) {
      setCloudError(authErrorMessage(err));
    }
  }, [db, session, refreshConnectivity]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const opened = await boot();
        const loaded = await loadSettings(opened);
        if (!live) return;
        setDb(opened);
        setSettings(loaded);
      } catch (err) {
        if (live) setError(authErrorMessage(err));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (db) void hydrate();
  }, [db, session.storeId, hydrate]);

  useEffect(() => {
    return listenConnectivity(() => {
      void hydrate();
    });
  }, [hydrate]);

  const value = useMemo<StoreValue | null>(() => {
    if (!db || !settings) return null;
    return {
      db,
      settings,
      session,
      online,
      connectionType,
      supabaseReach,
      functionsReach,
      cloudError,
      delistCount,
      incidentCount,
      cardPayments,
      cacheEpoch,
      hydrate,
      refreshConnectivity,
      ensureOnline,
      async setSetting(key, next) {
        await ensureOnline();
        await floorCloud().rpc("set_store_setting", { p_key: key, p_value: next });
        await hydrate();
      },
      async reloadSettings() {
        await hydrate();
      },
    };
  }, [
    db,
    settings,
    session,
    online,
    connectionType,
    supabaseReach,
    functionsReach,
    cloudError,
    delistCount,
    incidentCount,
    cardPayments,
    cacheEpoch,
    hydrate,
    refreshConnectivity,
    ensureOnline,
  ]);

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-10 text-body">
        <p className="mb-2 text-floor-danger">Floor could not open its cache.</p>
        <p className="text-quiet text-floor-mute">{error}</p>
      </div>
    );
  }

  if (!value) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md items-center justify-center text-quiet text-floor-mute">
        Floor
      </div>
    );
  }

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export { loadStaffSession };
