import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { floorCloud, authErrorMessage } from "@floor/cloud";
import { FloorSquare } from "@floor/square-plugin";
import { useStore } from "./store";
import { functionsUrl } from "./functions";
import { Notice } from "./components/ui";
import {
  clearPendingCapture,
  clearReaderIdentity,
  loadPendingCapture,
  loadReaderIdentity,
  savePendingCapture,
  saveReaderIdentity,
} from "./reader-storage";

export type PendingCharge = {
  id: string;
  sku: string;
  title: string | null;
  amount_cents: number;
  tax_cents: number;
};

type ReaderContextValue = {
  deviceId: string | null;
  pairCode: string;
  authorized: boolean;
  pending: PendingCharge[];
  error: string;
  status: string;
  chargingId: string | null;
  ensureDevice: () => Promise<string>;
  authorizeSdk: () => Promise<void>;
  takePayment: (charge: PendingCharge) => Promise<void>;
  resetPairing: () => Promise<void>;
  refreshPending: () => Promise<void>;
};

const ReaderContext = createContext<ReaderContextValue | null>(null);

export function useReader(): ReaderContextValue {
  const ctx = useContext(ReaderContext);
  if (!ctx) throw new Error("useReader requires ReaderProvider");
  return ctx;
}

async function authHeaders(): Promise<HeadersInit> {
  const { data } = await floorCloud().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("not_signed_in — open Setup and sign in again");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * Keeps the phone registered as the register's card reader for the whole app
 * session — heartbeat + pending-charge poll + capture recovery, not just one screen.
 */
export function ReaderProvider({ children }: { children: React.ReactNode }) {
  const { online, ensureOnline } = useStore();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [pending, setPending] = useState<PendingCharge[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [chargingId, setChargingId] = useState<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const authorizedRef = useRef(false);

  useEffect(() => {
    deviceIdRef.current = deviceId;
  }, [deviceId]);
  useEffect(() => {
    authorizedRef.current = authorized;
  }, [authorized]);

  const flushPendingCapture = useCallback(async () => {
    const saved = await loadPendingCapture();
    if (!saved) return;
    setStatus("Recovering a card capture that did not finish…");
    const { error: capErr } = await floorCloud().rpc("capture_register_charge", {
      p_charge_id: saved.chargeId,
      p_payment_id: saved.paymentId,
      p_card_brand: saved.cardBrand ?? null,
      p_card_last4: saved.cardLast4 ?? null,
    });
    if (capErr) {
      setError(
        `Card may already be charged (${saved.paymentId}). Capture retry failed: ${authErrorMessage(capErr)}. Keep the app open — register should still finalize if it sees captured.`,
      );
      return;
    }
    await clearPendingCapture();
    setStatus("Recovered capture — register will finalize the ticket.");
  }, []);

  const authorizeSdk = useCallback(async () => {
    setError("");
    await ensureOnline();
    const perms = await FloorSquare.preparePermissions?.();
    if (perms && !perms.ok) {
      throw new Error(
        perms.reason === "location_permission_required"
          ? "Allow Location for Floor (required by Square before any card charge)."
          : `Permissions required: ${perms.reason || "unknown"}`,
      );
    }
    const res = await fetch(functionsUrl("square-mobile-auth"), { headers: await authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === "square_not_connected") {
        throw new Error(
          "Square is not connected on the register. Open Register → Settings → Connect Square, then pick a location.",
        );
      }
      if (body.error === "square_location_required") {
        throw new Error(
          "Square is connected but no location is selected. On the register: Settings → List locations → pick one.",
        );
      }
      throw new Error(`square-mobile-auth HTTP ${res.status}: ${body.error || body.message || "unknown"}`);
    }
    if (!body.accessToken || !body.locationId) {
      throw new Error("square-mobile-auth returned no access token or location");
    }
    const result = await FloorSquare.authorize({
      accessToken: body.accessToken,
      locationId: body.locationId,
      mock: false,
    });
    if (!result.ok) {
      throw new Error(result.reason || "authorize_failed");
    }
    setAuthorized(true);
    authorizedRef.current = true;
    setStatus(result.already ? "Square already authorized" : "Square reader authorized");
  }, [ensureOnline]);

  const ensureDevice = useCallback(async () => {
    await ensureOnline();
    const sb = floorCloud();
    if (deviceIdRef.current) {
      const { error: hbErr } = await sb.rpc("heartbeat_pos_device", { p_device_id: deviceIdRef.current });
      if (!hbErr) return deviceIdRef.current;
      // Stored id may be gone — fall through to re-register.
      await clearReaderIdentity();
      deviceIdRef.current = null;
      setDeviceId(null);
      setPairCode("");
    }
    const stored = await loadReaderIdentity();
    if (stored) {
      const { error: hbErr } = await sb.rpc("heartbeat_pos_device", { p_device_id: stored.deviceId });
      if (!hbErr) {
        deviceIdRef.current = stored.deviceId;
        setDeviceId(stored.deviceId);
        setPairCode(stored.pairCode);
        return stored.deviceId;
      }
      await clearReaderIdentity();
    }
    const { data, error: rpcErr } = await sb.rpc("register_pos_reader", { p_label: "iPhone reader" });
    if (rpcErr) {
      throw new Error(`register_pos_reader failed: ${authErrorMessage(rpcErr)}`);
    }
    const row = data as { id: string; pair_code: string };
    if (!row?.id || !row?.pair_code) throw new Error("register_pos_reader returned no id/pair_code");
    await saveReaderIdentity(row.id, row.pair_code);
    deviceIdRef.current = row.id;
    setDeviceId(row.id);
    setPairCode(row.pair_code);
    return row.id;
  }, [ensureOnline]);

  const loadPending = useCallback(async (id: string) => {
    const { data, error: qErr } = await floorCloud()
      .from("card_charges")
      .select("id, sku, title, amount_cents, tax_cents")
      .eq("device_id", id)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (qErr) throw new Error(`Pending charges query failed: ${authErrorMessage(qErr)}`);
    setPending((data as PendingCharge[]) ?? []);
  }, []);

  const refreshPending = useCallback(async () => {
    const id = deviceIdRef.current ?? (await ensureDevice());
    await loadPending(id);
  }, [ensureDevice, loadPending]);

  const takePayment = useCallback(
    async (charge: PendingCharge) => {
      setError("");
      setChargingId(charge.id);
      setStatus("Charging…");
      try {
        await ensureOnline();
        if (!authorizedRef.current) {
          await authorizeSdk();
        }
        const state = await FloorSquare.authState?.();
        if (state && state.state !== "authorized") {
          await authorizeSdk();
        }
        const perms = await FloorSquare.preparePermissions?.();
        if (perms && !perms.ok) {
          throw new Error(
            perms.reason === "location_permission_required"
              ? "Allow Location for Floor, then try Take payment again."
              : `Permissions: ${perms.reason || "denied"}`,
          );
        }
        const result = await FloorSquare.charge({
          amountCents: charge.amount_cents,
          mock: false,
          referenceId: charge.id,
        });
        if (!result.ok || !result.paymentId) {
          await floorCloud()
            .from("card_charges")
            .update({
              status: "failed",
              error: result.reason || "declined",
              updated_at: new Date().toISOString(),
            })
            .eq("id", charge.id);
          setError(result.reason || "Card declined");
          setStatus("");
          return;
        }
        await savePendingCapture({
          chargeId: charge.id,
          paymentId: result.paymentId,
          cardBrand: result.cardBrand ?? null,
          cardLast4: result.cardLast4 ?? null,
          savedAt: new Date().toISOString(),
        });
        const { error: capErr } = await floorCloud().rpc("capture_register_charge", {
          p_charge_id: charge.id,
          p_payment_id: result.paymentId,
          p_card_brand: result.cardBrand ?? null,
          p_card_last4: result.cardLast4 ?? null,
        });
        if (capErr) throw new Error(`capture_register_charge failed: ${authErrorMessage(capErr)}`);
        await clearPendingCapture();
        setStatus("Captured — register will finalize the ticket.");
        if (deviceIdRef.current) await loadPending(deviceIdRef.current);
      } catch (err) {
        setError(authErrorMessage(err));
        setStatus("");
      } finally {
        setChargingId(null);
      }
    },
    [authorizeSdk, ensureOnline, loadPending],
  );

  const resetPairing = useCallback(async () => {
    await clearReaderIdentity();
    deviceIdRef.current = null;
    setDeviceId(null);
    setPairCode("");
    setPending([]);
    setError("");
    setStatus("Pairing cleared — registering a new reader…");
    try {
      await ensureDevice();
    } catch (err) {
      setError(authErrorMessage(err));
    }
  }, [ensureDevice]);

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        if (!online) {
          if (!stop) setError("Device offline — connect to Wi‑Fi to act as a reader.");
          return;
        }
        await flushPendingCapture();
        if (stop) return;
        const id = await ensureDevice();
        if (stop) return;
        await loadPending(id);
        if (!stop) setError("");
      } catch (err) {
        if (!stop) setError(authErrorMessage(err));
      }
    }
    void tick();
    const t = setInterval(() => void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [online, ensureDevice, loadPending, flushPendingCapture]);

  const value = useMemo(
    () => ({
      deviceId,
      pairCode,
      authorized,
      pending,
      error,
      status,
      chargingId,
      ensureDevice,
      authorizeSdk,
      takePayment,
      resetPairing,
      refreshPending,
    }),
    [
      deviceId,
      pairCode,
      authorized,
      pending,
      error,
      status,
      chargingId,
      ensureDevice,
      authorizeSdk,
      takePayment,
      resetPairing,
      refreshPending,
    ],
  );

  return (
    <ReaderContext.Provider value={value}>
      {children}
      <ReaderChargeOverlay />
    </ReaderContext.Provider>
  );
}

function ReaderChargeOverlay() {
  const { pending, chargingId, takePayment, error, status } = useReader();
  if (!pending.length && !status && !error) return null;
  const top = pending[0];
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-floor-line bg-floor-bg/95 p-3 backdrop-blur sm:mx-auto sm:max-w-md">
      {error ? <Notice tone="error">{error}</Notice> : null}
      {status ? <p className="text-quiet mb-2">{status}</p> : null}
      {top ? (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-body truncate">{top.title || top.sku}</p>
            <p className="text-quiet text-sm">
              Card charge ${(top.amount_cents / 100).toFixed(2)}
              {pending.length > 1 ? ` · +${pending.length - 1} more` : ""}
            </p>
          </div>
          <button
            type="button"
            className="btn-accent shrink-0"
            disabled={chargingId === top.id}
            onClick={() => void takePayment(top)}
          >
            {chargingId === top.id ? "Charging…" : "Charge card"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
