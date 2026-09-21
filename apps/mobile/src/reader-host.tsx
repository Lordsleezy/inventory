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
  locationId: string | null;
  locationName: string | null;
  sandbox: boolean | null;
  authorizing: boolean;
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

/** Map native/plugin reason codes to actionable copy. Always keep Square's code/message visible. */
export function squareSdkErrorMessage(result: {
  reason?: string;
  message?: string;
  code?: number;
  localizedDescription?: string;
}): string {
  const reason = (result.reason || "").trim();
  const detail = (result.message || result.localizedDescription || "").trim();
  const codeBit = result.code != null ? ` (code ${result.code})` : "";
  switch (reason) {
    case "sdk_not_initialized":
    case "sdk_not_installed":
    case "square_sdk_not_linked":
    case "sdk_not_in_build":
      return detail || "This build does not include a working Square Mobile Payments SDK (framework missing or SquareApplicationID not baked in).";
    case "sandbox_mock_reader_required":
      return (
        detail ||
        "Sandbox needs Square’s floating Mock Reader before charging (physical readers don’t work in sandbox). Tap the mock reader after it appears, add a contactless reader, then Charge again."
      );
    case "start_payment_exception":
    case "authorize_exception":
      return detail || "Square threw an exception. Try Authorize again, allow Location, and use the mock reader in sandbox.";
    case "not_authorized":
      return detail || "Square SDK is not authorized yet. Connect Square + pick a location on the register, then Authorize on this phone.";
    case "location_permission_required":
      return detail || "Allow Location for Floor — Square requires it before any card charge.";
    case "location_fix_required":
      return (
        detail ||
        "Location permission is on, but Floor still needs a GPS fix before Square authorize. Enable Precise Location and try again."
      );
    case "unsupportedCountry":
    case "authorization_unsupported_country":
      return (
        detail ||
        "Square rejected authorize as unsupported country. Confirm: (1) IPA and Netlify share the same sandbox Application ID, (2) the selected Square location is a US/CA/GB/AU sandbox location, (3) Precise Location is on and a GPS fix completed before authorize."
      );
    case "mock_authorize_disabled":
    case "mock_charge_disabled":
      return detail || "Live Square is required for register card charges. Connect Square on the register and pick a location.";
    case "missing_credentials":
      return detail || "Server did not return Square credentials. Connect Square on the register and pick a location.";
    case "canceled":
      return "Card payment canceled.";
    case "app_id_mismatch":
      return detail || "This IPA’s Square Application ID does not match the server’s sandbox/production app.";
    default:
      if (detail) return detail;
      if (reason) return `Square error${codeBit}: ${reason}`;
      return `Square payment failed${codeBit}`;
  }
}

function isTransientReaderError(msg: string): boolean {
  return /offline|register_pos_reader|Pending charges query|not_signed_in|Device offline/i.test(msg);
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
  const [locationId, setLocationId] = useState<string | null>(null);
  const [locationName, setLocationName] = useState<string | null>(null);
  const [sandbox, setSandbox] = useState<boolean | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [pending, setPending] = useState<PendingCharge[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [chargingId, setChargingId] = useState<string | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const authorizedRef = useRef(false);
  const locationIdRef = useRef<string | null>(null);

  useEffect(() => {
    deviceIdRef.current = deviceId;
  }, [deviceId]);
  useEffect(() => {
    authorizedRef.current = authorized;
  }, [authorized]);
  useEffect(() => {
    locationIdRef.current = locationId;
  }, [locationId]);

  const reportAuthHeartbeat = useCallback(
    async (id: string, isAuthorized: boolean, loc: string | null) => {
      const { error: hbErr } = await floorCloud().rpc("heartbeat_pos_device", {
        p_device_id: id,
        p_square_authorized: isAuthorized,
        p_square_location_id: loc,
      });
      if (hbErr) {
        // Fall back to last-seen-only heartbeat so pairing stays fresh even if migration lags.
        await floorCloud().rpc("heartbeat_pos_device", { p_device_id: id });
      }
    },
    [],
  );

  const flushPendingCapture = useCallback(async () => {
    const saved = await loadPendingCapture();
    if (!saved) return;
    if (saved.phase === "sdk_presented" && !saved.paymentId) {
      setStatus(
        "Last card attempt may have opened Square but never finished. Check Square Dashboard for a charge; the register may still be waiting or timed out.",
      );
      // Do not clear — user/register recovery decides. Drop after 30 minutes.
      const age = Date.now() - Date.parse(saved.savedAt || "") ;
      if (Number.isFinite(age) && age > 30 * 60_000) await clearPendingCapture();
      return;
    }
    if (!saved.paymentId) return;
    setStatus("Recovering a card capture that did not finish…");
    const { error: capErr } = await floorCloud().rpc("capture_register_charge", {
      p_charge_id: saved.chargeId,
      p_payment_id: saved.paymentId,
      p_card_brand: saved.cardBrand ?? null,
      p_card_last4: saved.cardLast4 ?? null,
    });
    if (capErr) {
      setError(
        `Card may already be charged (${saved.paymentId}). Capture retry failed: ${authErrorMessage(capErr)}. Keep the app open — register Tender can Finalize or Refund an orphaned capture.`,
      );
      return;
    }
    await clearPendingCapture();
    setStatus("Recovered capture — register will finalize the ticket.");
  }, []);

  const authorizeSdk = useCallback(async () => {
    setAuthorizing(true);
    setError("");
    setStatus("Requesting Location / Bluetooth, then authorizing Square…");
    try {
      await ensureOnline();
      const perms = await FloorSquare.preparePermissions?.();
      if (perms && !perms.ok) {
        throw new Error(squareSdkErrorMessage(perms));
      }
      setStatus("Fetching Square credentials from the store…");
      const res = await fetch(functionsUrl("square-mobile-auth"), { headers: await authHeaders() });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        accessToken?: string;
        locationId?: string;
        locationName?: string | null;
        locationCountry?: string | null;
        sandbox?: boolean;
        applicationId?: string | null;
        verificationError?: string | null;
      };
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
        if (body.error === "square_location_unsupported_country") {
          throw new Error(body.message || "Square location country is not supported by Mobile Payments SDK.");
        }
        if (body.error === "square_app_id_environment_mismatch") {
          throw new Error(body.message || "Square Application ID environment mismatch between IPA and server.");
        }
        if (body.error === "square_location_lookup_failed") {
          throw new Error(body.message || "Could not verify Square location with the store token.");
        }
        throw new Error(
          body.message || `square-mobile-auth HTTP ${res.status}: ${body.error || "unknown"}`,
        );
      }
      if (!body.accessToken || !body.locationId) {
        throw new Error("square-mobile-auth returned no access token or location");
      }

      const stateBefore = await FloorSquare.authState?.();
      const bakedAppId = (stateBefore?.squareApplicationId || "").trim();
      const serverAppId = (body.applicationId || "").trim();
      if (bakedAppId && serverAppId && bakedAppId !== serverAppId) {
        throw new Error(
          squareSdkErrorMessage({
            reason: "app_id_mismatch",
            message: `Square Application ID mismatch — IPA has ${bakedAppId}, server has ${serverAppId}. Rebuild the phone app with the same SQUARE_APPLICATION_ID as Netlify.`,
          }),
        );
      }

      if (body.verificationError) {
        // Token/location lookup failed (often 401) — still attempt SDK authorize, but keep the warning visible.
        setError(body.verificationError);
      }

      setStatus(
        `Authorizing Square SDK… ${body.locationName || body.locationId}${
          body.locationCountry ? ` · ${body.locationCountry}` : ""
        }${body.sandbox ? " (sandbox)" : ""}${serverAppId ? ` · app ${serverAppId.slice(0, 14)}…` : ""}`,
      );
      console.info("[floor-square] authorize", {
        locationId: body.locationId,
        locationName: body.locationName,
        locationCountry: body.locationCountry,
        sandbox: body.sandbox,
        applicationId: serverAppId || null,
        bakedAppId: bakedAppId || null,
        tokenLen: body.accessToken.length,
        verificationError: body.verificationError || null,
        locationFix: perms,
      });

      const result = await FloorSquare.authorize({
        accessToken: body.accessToken,
        locationId: body.locationId,
        mock: false,
      });
      console.info("[floor-square] authorize result", result);
      if (!result.ok) {
        throw new Error(squareSdkErrorMessage(result));
      }

      setAuthorized(true);
      authorizedRef.current = true;
      setLocationId(body.locationId);
      locationIdRef.current = body.locationId;
      setLocationName(body.locationName ?? null);
      setSandbox(body.sandbox ?? null);

      const locLabel = body.locationName
        ? `${body.locationName} (${body.locationId})`
        : body.locationId;
      let nextStatus = result.already
        ? `Square already authorized · ${locLabel}`
        : `Square authorized · ${locLabel}`;
      if (body.sandbox) nextStatus += " · sandbox";

      const mock = await FloorSquare.presentMockReader?.();
      console.info("[floor-square] presentMockReader", mock);
      if (mock && !mock.ok && !mock.skipped) {
        nextStatus += `. Mock reader failed: ${squareSdkErrorMessage(mock)}`;
        setError(squareSdkErrorMessage(mock));
      } else if (mock?.mockReaderPresented || (body.sandbox && mock?.ok)) {
        nextStatus +=
          ". Tap the floating Mock Reader → add Contactless & chip, then you’re ready for Card on the register.";
      } else if (body.sandbox) {
        nextStatus += ". Sandbox: open Mock Reader if it didn’t appear (re-authorize).";
      }
      setStatus(nextStatus);

      if (deviceIdRef.current) {
        await reportAuthHeartbeat(deviceIdRef.current, true, body.locationId);
      }
    } catch (err) {
      const msg = authErrorMessage(err);
      console.error("[floor-square] authorize failed", err);
      setAuthorized(false);
      authorizedRef.current = false;
      setError(msg);
      setStatus("");
      if (deviceIdRef.current) {
        await reportAuthHeartbeat(deviceIdRef.current, false, null).catch(() => {});
      }
      throw err instanceof Error ? err : new Error(msg);
    } finally {
      setAuthorizing(false);
    }
  }, [ensureOnline, reportAuthHeartbeat]);

  const ensureDevice = useCallback(async () => {
    await ensureOnline();
    const sb = floorCloud();
    const tryHeartbeat = async (id: string) => {
      const { error: hbErr } = await sb.rpc("heartbeat_pos_device", {
        p_device_id: id,
        p_square_authorized: authorizedRef.current,
        p_square_location_id: locationIdRef.current,
      });
      if (!hbErr) return true;
      const { error: hb2 } = await sb.rpc("heartbeat_pos_device", { p_device_id: id });
      return !hb2;
    };
    if (deviceIdRef.current) {
      if (await tryHeartbeat(deviceIdRef.current)) return deviceIdRef.current;
      await clearReaderIdentity();
      deviceIdRef.current = null;
      setDeviceId(null);
      setPairCode("");
    }
    const stored = await loadReaderIdentity();
    if (stored) {
      if (await tryHeartbeat(stored.deviceId)) {
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
    await tryHeartbeat(row.id);
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
          throw new Error(squareSdkErrorMessage(perms));
        }
        await savePendingCapture({
          chargeId: charge.id,
          phase: "sdk_presented",
          savedAt: new Date().toISOString(),
        });
        const result = await FloorSquare.charge({
          amountCents: charge.amount_cents,
          mock: false,
          referenceId: charge.id,
        });
        if (!result.ok || !result.paymentId) {
          await clearPendingCapture();
          await floorCloud()
            .from("card_charges")
            .update({
              status: "failed",
              error: result.message || result.reason || "declined",
              updated_at: new Date().toISOString(),
            })
            .eq("id", charge.id);
          setError(squareSdkErrorMessage(result));
          setStatus("");
          return;
        }
        await savePendingCapture({
          chargeId: charge.id,
          paymentId: result.paymentId,
          cardBrand: result.cardBrand ?? null,
          cardLast4: result.cardLast4 ?? null,
          phase: "captured",
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
        if (!stop) {
          setError((prev) => (prev && !isTransientReaderError(prev) ? prev : ""));
        }
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
      locationId,
      locationName,
      sandbox,
      authorizing,
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
      locationId,
      locationName,
      sandbox,
      authorizing,
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
