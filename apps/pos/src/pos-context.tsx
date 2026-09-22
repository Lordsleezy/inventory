import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  floorCloud,
  loadStoreSetting,
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

export type StoreRewardsSettings = {
  clerkMaxDiscountBps: number;
  rewardsEnabled: boolean;
  rewardsPointsPerDollar: number;
  rewardsPointValueCents: number;
  rewardsSignupDiscountBps: number;
  storeDisplayName: string;
};

const DEFAULT_REWARDS: StoreRewardsSettings = {
  clerkMaxDiscountBps: 1000,
  rewardsEnabled: true,
  rewardsPointsPerDollar: 1,
  rewardsPointValueCents: 1,
  rewardsSignupDiscountBps: 500,
  storeDisplayName: "Floor",
};

type PosValue = {
  session: StaffSession;
  online: boolean;
  settings: PosSettings;
  taxRateBps: number | null;
  rewards: StoreRewardsSettings;
  pendingOutbox: number;
  incidents: { id: string; sku: string; message: string; createdAt: string }[];
  isAdmin: boolean;
  refreshUnits: () => Promise<void>;
  refreshLocal: () => Promise<void>;
  refreshTax: () => Promise<void>;
  refreshRewards: () => Promise<void>;
  saveSettings: (next: PosSettings) => Promise<void>;
  syncOutbox: () => Promise<void>;
};

const Ctx = createContext<PosValue | null>(null);

export function usePos(): PosValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePos outside provider");
  return v;
}

function numSetting(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "string") {
    const n = Number(raw.replace(/"/g, ""));
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function boolSetting(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === '"true"') return true;
  if (raw === "false" || raw === '"false"') return false;
  return fallback;
}

function textSetting(raw: unknown, fallback: string): string {
  if (typeof raw === "string") return raw.replace(/^"|"$/g, "") || fallback;
  if (raw != null && typeof raw !== "object") return String(raw);
  return fallback;
}

export function PosProvider({ session, children }: { session: StaffSession; children: ReactNode }) {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [settings, setSettings] = useState<PosSettings | null>(null);
  const [taxRateBps, setTaxRateBps] = useState<number | null>(null);
  const [rewards, setRewards] = useState<StoreRewardsSettings>(DEFAULT_REWARDS);
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

  const refreshRewards = useCallback(async () => {
    try {
      const [maxDisc, enabled, perDollar, pointValue, signupBps, displayName] = await Promise.all([
        loadStoreSetting("clerk_max_discount_bps"),
        loadStoreSetting("rewards_enabled"),
        loadStoreSetting("rewards_points_per_dollar"),
        loadStoreSetting("rewards_point_value_cents"),
        loadStoreSetting("rewards_signup_discount_bps"),
        loadStoreSetting("display_name"),
      ]);
      setRewards({
        clerkMaxDiscountBps: numSetting(maxDisc, DEFAULT_REWARDS.clerkMaxDiscountBps),
        rewardsEnabled: boolSetting(enabled, DEFAULT_REWARDS.rewardsEnabled),
        rewardsPointsPerDollar: numSetting(perDollar, DEFAULT_REWARDS.rewardsPointsPerDollar),
        rewardsPointValueCents: numSetting(pointValue, DEFAULT_REWARDS.rewardsPointValueCents),
        rewardsSignupDiscountBps: numSetting(signupBps, DEFAULT_REWARDS.rewardsSignupDiscountBps),
        storeDisplayName: textSetting(displayName, DEFAULT_REWARDS.storeDisplayName),
      });
    } catch {
      /* keep defaults until RPC/settings land */
    }
  }, []);

  const refreshUnits = useCallback(async () => {
    if (!navigator.onLine) return;
    const sb = floorCloud();
    const { data, error } = await sb
      .from("units_pos")
      .select("sku, title, brand, model, category, condition, ask_cents, state, qty_on_hand")
      .eq("state", "available")
      .order("sku", { ascending: false })
      .limit(2000);
    if (error) {
      // qty_on_hand may not exist yet — fall back without it
      const fallback = await sb
        .from("units_pos")
        .select("sku, title, brand, model, category, condition, ask_cents, state")
        .eq("state", "available")
        .order("sku", { ascending: false })
        .limit(2000);
      if (fallback.error) throw fallback.error;
      const units: CachedUnit[] = (fallback.data ?? []).map((row) => {
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
          qtyOnHand: 1,
          photoUrl: null,
        };
      });
      await cacheReplaceUnits(units);
      await refreshTax();
      return;
    }
    const units: CachedUnit[] = (data ?? []).map((row) => {
      const clean = stripCostFromUnit(row as Record<string, unknown>);
      const qtyRaw = (row as { qty_on_hand?: unknown }).qty_on_hand;
      return {
        sku: String(clean.sku ?? ""),
        title: String(clean.title ?? ""),
        brand: clean.brand ? String(clean.brand) : null,
        model: clean.model ? String(clean.model) : null,
        category: clean.category ? String(clean.category) : null,
        condition: clean.condition ? String(clean.condition) : null,
        askCents: typeof clean.ask_cents === "number" ? clean.ask_cents : null,
        state: String(clean.state ?? "available"),
        qtyOnHand: typeof qtyRaw === "number" && qtyRaw > 0 ? qtyRaw : 1,
        photoUrl: null,
      };
    });
    await cacheReplaceUnits(units);
    await refreshTax();
  }, [refreshTax]);

  const syncOutboxNow = useCallback(async () => {
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
    void refreshRewards();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [refreshLocal, refreshTax, refreshRewards]);

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
      rewards,
      pendingOutbox,
      incidents,
      isAdmin,
      refreshUnits,
      refreshLocal,
      refreshTax,
      refreshRewards,
      saveSettings,
      syncOutbox: syncOutboxNow,
    };
  }, [
    session,
    online,
    settings,
    taxRateBps,
    rewards,
    pendingOutbox,
    incidents,
    isAdmin,
    refreshUnits,
    refreshLocal,
    refreshTax,
    refreshRewards,
    saveSettings,
    syncOutboxNow,
  ]);

  if (!value) return <p className="page">Loading register…</p>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
