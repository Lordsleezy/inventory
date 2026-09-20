import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  finalizeSale,
  floorCloud,
  releaseReservation,
  reserveUnit,
  stripCostFromUnit,
  type StaffSession,
} from "@floor/cloud";
import {
  cacheReplaceUnits,
  incidentInsert,
  incidentsList,
  loadPosSettings,
  outboxPending,
  outboxUpdate,
  savePosSettings,
  type CachedUnit,
  type PosSettings,
} from "./local";
import { syncOutboxRow } from "./outbox";
import { printReceipt } from "./print-receipt";
import { finalizeCapturedCharge, replayCapturedCharges } from "./card-device";
import { callFunction } from "./functions";

type PosValue = {
  session: StaffSession;
  online: boolean;
  settings: PosSettings;
  pendingOutbox: number;
  incidents: { id: string; sku: string; message: string; createdAt: string }[];
  isAdmin: boolean;
  refreshUnits: () => Promise<void>;
  refreshLocal: () => Promise<void>;
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
  const [pendingOutbox, setPendingOutbox] = useState(0);
  const [incidents, setIncidents] = useState<PosValue["incidents"]>([]);
  const isAdmin = session.role === "owner" || session.role === "manager";

  const refreshLocal = useCallback(async () => {
    setSettings(await loadPosSettings());
    setPendingOutbox((await outboxPending()).length);
    setIncidents(await incidentsList());
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
    const { data: tax } = await sb
      .from("store_settings")
      .select("key, value")
      .eq("store_id", session.storeId)
      .eq("key", "taxRateBps")
      .maybeSingle();
    const current = await loadPosSettings();
    const raw = tax?.value;
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
    const bps = Number.isFinite(parsed) ? parsed : current.taxRateBps;
    await savePosSettings({ ...current, taxRateBps: bps });
  }, [session.storeId]);

  const syncOutboxNow = useCallback(async () => {
    if (!navigator.onLine) return;
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

  const recoverCaptured = useCallback(async () => {
    if (!navigator.onLine) return;
    const rows = await replayCapturedCharges();
    const current = await loadPosSettings();
    for (const row of rows) {
      try {
        const sale = (await finalizeCapturedCharge(row.id)) as { receipt_no?: string };
        await printReceipt(
          {
            receiptNo: sale?.receipt_no || "SALE",
            soldAt: new Date().toLocaleString(),
            clerkName: session.displayName,
            sku: row.sku,
            title: "Item",
            condition: null,
            priceCents: 0,
            taxCents: 0,
            totalCents: 0,
            tender: "CARD",
          },
          current,
        );
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        if (/unit_not_sellable|double_sell|23505/i.test(text)) {
          await callFunction("square-refund", {
            method: "POST",
            body: JSON.stringify({ paymentId: row.paymentId, sku: row.sku, chargeId: row.id }),
          });
          await incidentInsert(
            crypto.randomUUID(),
            row.sku,
            "INCIDENT — card charged but unit is not ours. Refund sent. Do not retry.",
          );
        }
      }
    }
    await refreshLocal();
  }, [refreshLocal, session.displayName]);

  useEffect(() => {
    void refreshLocal();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [refreshLocal]);

  useEffect(() => {
    if (!online) return;
    void refreshUnits()
      .then(() => refreshLocal())
      .then(() => syncOutboxNow())
      .then(() => recoverCaptured())
      .catch(() => {});
  }, [online, refreshUnits, refreshLocal, syncOutboxNow, recoverCaptured]);

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
      pendingOutbox,
      incidents,
      isAdmin,
      refreshUnits,
      refreshLocal,
      saveSettings,
      syncOutbox: syncOutboxNow,
    };
  }, [session, online, settings, pendingOutbox, incidents, isAdmin, refreshUnits, refreshLocal, saveSettings, syncOutboxNow]);

  if (!value) return <p className="page">Loading register…</p>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
