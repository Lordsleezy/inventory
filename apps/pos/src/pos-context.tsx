import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  floorCloud,
  loadStoreTaxRateBps,
  stripCostFromUnit,
  type StaffSession,
} from "@floor/cloud";
import {
  cacheReplaceUnits,
  incidentInsert,
  incidentsList,
  loadPosSettings,
  outboxPending,
  savePosSettings,
  type CachedUnit,
  type PosSettings,
} from "./local";
import { syncOutboxRow } from "./outbox";
import { finalizeSale, releaseReservation, reserveUnit } from "@floor/cloud";

type PosValue = {
  session: StaffSession;
  online: boolean;
  settings: PosSettings;
  taxRateBps: number | null;
  pendingOutbox: number;
  incidents: { id: string; sku: string; message: string; createdAt: string }[];
  isAdmin: boolean;
  refreshUnits: () => Promise<void>;
  refreshLocal: () => Promise<void>;
  refreshTax: () => Promise<void>;
  saveSettings: (next: PosSettings) => Promise<void>;
  syncOutbox: () => Promise<void>;
};

const Ctx = createContext<PosValue | null>(null);

export function usePos(): PosValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePos outside provider");
  return v;
}

export function PosProvider({ session, children }: { session: StaffSession; children: ReactNode }) {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [settings, setSettings] = useState<PosSettings | null>(null);
  const [taxRateBps, setTaxRateBps] = useState<number | null>(null);
  const [pendingOutbox, setPendingOutbox] = useState(0);
  const [incidents, setIncidents] = useState<PosValue["incidents"]>([]);
  const isAdmin = session.role === "owner" || session.role === "manager";

  const refreshLocal = useCallback(async () => {
    setSettings(await loadPosSettings());
    setPendingOutbox((await outboxPending()).length);
    setIncidents(await incidentsList());
  }, []);

  const refreshTax = useCallback(async () => {
    try {
      setTaxRateBps(await loadStoreTaxRateBps());
    } catch {
      /* keep last */
    }
  }, []);

  const refreshUnits = useCallback(async () => {
    if (!navigator.onLine) return;
    const sb = floorCloud();
    const { data, error } = await sb
      .from("units_pos")
      .select("sku, title, brand, model, category, condition, ask_cents, state")
      .eq("state", "available")
      .order("sku", { ascending: false })
      .limit(2000);
    if (error) throw error;
    const units: CachedUnit[] = (data ?? []).map((row) => {
      const clean = stripCostFromUnit(row as Record<string, unknown>);
      return {
        sku: String(clean.sku ?? ""),
        title: String(clean.title ?? ""),
        brand: clean.brand ? String(clean.brand) : null,
        model: clean.model ? String(clean.model) : null,
        category: clean.category ? String(clean.category) : null,
        condition: clean.condition ? String(clean.condition) : null,
        askCents: typeof clean.ask_cents === "number" ? clean.ask_cents : null,
        state: String(clean.state ?? "available"),
      };
    });
    await cacheReplaceUnits(units);
    await refreshTax();
  }, [refreshTax]);

  const syncOutboxNow = useCallback(async () => {
    // Legacy outbox retained for old rows only — new sales never enqueue.
    if (!navigator.onLine) return;
    const { outboxUpdate } = await import("./local");
    const rows = await outboxPending();
    for (const row of rows) {
      const result = await syncOutboxRow(row, {
        reserve: reserveUnit,
        finalize: async (args) => {
          const sale = await finalizeSale(args);
          return sale as { receipt_no?: string };
        },
        release: releaseReservation,
      });
      if (result.kind === "synced") {
        await outboxUpdate(row.id, "synced", result.receiptNo, null);
      } else if (result.kind === "incident") {
        await outboxUpdate(row.id, "incident", null, result.message);
        await incidentInsert(crypto.randomUUID(), row.sku, result.message);
      }
    }
    await refreshLocal();
  }, [refreshLocal]);

  useEffect(() => {
    void refreshLocal();
    void refreshTax();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [refreshLocal, refreshTax]);

  useEffect(() => {
    if (!online) return;
    void refreshUnits()
      .then(() => refreshLocal())
      .then(() => syncOutboxNow())
      .catch(() => {});
  }, [online, refreshUnits, refreshLocal, syncOutboxNow]);

  const saveSettings = useCallback(async (next: PosSettings) => {
    await savePosSettings(next);
    setSettings(next);
  }, []);

  const value = useMemo<PosValue | null>(() => {
    if (!settings) return null;
    return {
      session,
      online,
      settings,
      taxRateBps,
      pendingOutbox,
      incidents,
      isAdmin,
      refreshUnits,
      refreshLocal,
      refreshTax,
      saveSettings,
      syncOutbox: syncOutboxNow,
    };
  }, [
    session,
    online,
    settings,
    taxRateBps,
    pendingOutbox,
    incidents,
    isAdmin,
    refreshUnits,
    refreshLocal,
    refreshTax,
    saveSettings,
    syncOutboxNow,
  ]);

  if (!value) return <p className="page">Loading register…</p>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
