import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { initDb, loadSettings, type Db, type Settings } from "@floor/store";
import {
  assertCacheHasNoCost,
  assertOnline,
  cacheUnitRow,
  floorCloud,
  loadStaffSession,
  relockCacheReplica,
  resetCacheReplica,
  wipeCostFromCache,
  type StaffSession,
} from "@floor/cloud";

type StoreValue = {
  db: Db;
  settings: Settings;
  session: StaffSession;
  online: boolean;
  delistCount: number;
  incidentCount: number;
  cardPayments: boolean;
  hydrate: () => Promise<void>;
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
    paymentMethods: readList("paymentMethods", ["cash", "card", "other"]),
    cardPayments: map.get("card_payments_enabled") === true || map.get("card_payments_enabled") === "true",
  };
}

async function hydrateCache(db: Db, session: StaffSession): Promise<{ delist: number; incidents: number }> {
  const sb = floorCloud();
  const staffView = session.role === "staff";
  const units = staffView
    ? await sb.from("units_pos").select("*")
    : await sb.from("units").select("*");
  if (units.error) throw new Error(units.error.message);

  await resetCacheReplica(db);

  for (const raw of units.data ?? []) {
    const row = cacheUnitRow(raw as Record<string, unknown>, { includeCost: !staffView });
    const issuedAt = String(row.received_at ?? new Date().toISOString());
    await db.run(`INSERT INTO sku_ledger (sku, issued_at, label, fate) VALUES (?,?,?,?)`, [
      String(row.sku),
      issuedAt,
      "",
      row.state === "sold" ? "sold" : "issued",
    ]);
    await db.run(
      `INSERT INTO units (
        sku, brand, model, title, category, condition, test_status, location, mfr_serial,
        defect_notes, upc, lot, acquisition_cost_cents, msrp_cents, ask_cents, floor_cents,
        state, received_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        String(row.sku),
        String(row.brand ?? ""),
        String(row.model ?? ""),
        String(row.title ?? ""),
        row.category == null ? null : String(row.category),
        row.condition == null ? null : String(row.condition),
        row.test_status == null ? null : String(row.test_status),
        row.location == null ? null : String(row.location),
        row.mfr_serial == null ? null : String(row.mfr_serial),
        row.defect_notes == null ? null : String(row.defect_notes),
        row.upc == null ? null : String(row.upc),
        row.lot == null ? null : String(row.lot),
        row.acquisition_cost_cents == null ? null : Number(row.acquisition_cost_cents),
        row.msrp_cents == null ? null : Number(row.msrp_cents),
        row.ask_cents == null ? null : Number(row.ask_cents),
        row.floor_cents == null ? null : Number(row.floor_cents),
        String(row.state ?? "available"),
        issuedAt,
        String(row.updated_at ?? issuedAt),
      ],
    );
  }

  if (staffView) {
    await wipeCostFromCache(db);
    await assertCacheHasNoCost(db);
  }

  const salesQuery = staffView
    ? sb.from("sales").select("*").eq("actor_id", session.userId)
    : sb.from("sales").select("*");
  const sales = await salesQuery;
  for (const s of sales.data ?? []) {
    await db.run(
      `INSERT INTO sales (id, sku, price_cents, channel, payment_method, customer_name, customer_phone, customer_email, note, sold_at, receipt_no, voided_at, void_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        s.id, s.sku, s.price_cents, s.channel, s.payment_method, s.customer_name, s.customer_phone,
        s.customer_email, s.note, s.sold_at, s.receipt_no, s.voided_at, s.void_reason,
      ],
    );
  }

  const photos = await sb.from("photos").select("*");
  for (const p of photos.data ?? []) {
    await db.run(
      `INSERT INTO photos (id, sku, path, created_at, is_primary) VALUES (?,?,?,?,?)`,
      [p.id, p.sku, p.path, p.created_at, p.is_primary ? 1 : 0],
    );
  }

  const events = await sb.from("events").select("id, at, sku, kind, field, old_value, new_value, actor, note");
  for (const e of events.data ?? []) {
    await db.run(
      `INSERT INTO events (id, at, sku, kind, field, old_value, new_value, actor, note) VALUES (?,?,?,?,?,?,?,?,?)`,
      [e.id, e.at, e.sku, e.kind, e.field, e.old_value, e.new_value, e.actor ?? "floor", e.note],
    );
  }

  await relockCacheReplica(db);

  const delist = await sb.from("delist_tasks").select("id", { count: "exact", head: true }).is("completed_at", null);
  const incidents = await sb.from("incidents").select("id", { count: "exact", head: true }).is("resolved_at", null);
  return { delist: delist.count ?? 0, incidents: incidents.count ?? 0 };
}

export function StoreProvider({ session, children }: { session: StaffSession; children: React.ReactNode }) {
  const [db, setDb] = useState<Db | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [online, setOnline] = useState(true);
  const [delistCount, setDelistCount] = useState(0);
  const [incidentCount, setIncidentCount] = useState(0);
  const [cardPayments, setCardPayments] = useState(false);
  const [error, setError] = useState("");

  async function hydrate() {
    if (!db) return;
    try {
      await assertOnline();
      setOnline(true);
      const cloudSettings = await settingsFromCloud(session);
      await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
        "storeName",
        JSON.stringify(cloudSettings.storeName),
      ]);
      setSettings((prev) => ({ ...(prev as Settings), ...cloudSettings }));
      setCardPayments(cloudSettings.cardPayments);
      const counts = await hydrateCache(db, session);
      setDelistCount(counts.delist);
      setIncidentCount(counts.incidents);
    } catch {
      setOnline(false);
    }
  }

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
        if (live) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (db) void hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, session.storeId]);

  const value = useMemo<StoreValue | null>(() => {
    if (!db || !settings) return null;
    return {
      db,
      settings,
      session,
      online,
      delistCount,
      incidentCount,
      cardPayments,
      hydrate,
      async setSetting(key, next) {
        await assertOnline();
        await floorCloud().rpc("set_store_setting", { p_key: key, p_value: next });
        await hydrate();
      },
      async reloadSettings() {
        await hydrate();
      },
    };
  }, [db, settings, session, online, delistCount, incidentCount, cardPayments]);

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
