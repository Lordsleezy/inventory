import { useEffect, useState } from "react";
import { floorCloud, authErrorMessage } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";
import { FloorSquare } from "@floor/square-plugin";
import { functionsUrl } from "../functions";

/**
 * Phone acts as the card reader for the register.
 * Pair code, heartbeat, accept pending card_charges via Square Mobile Payments SDK.
 */
export function PaymentDeviceScreen() {
  const { session, online, ensureOnline } = useStore();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [pending, setPending] = useState<
    { id: string; sku: string; title: string | null; amount_cents: number; tax_cents: number }[]
  >([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  async function authHeaders(): Promise<HeadersInit> {
    const { data } = await floorCloud().auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("not_signed_in — open Setup and sign in again");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  async function authorizeSdk() {
    setError("");
    await ensureOnline();
    const res = await fetch(functionsUrl("square-mobile-auth"), { headers: await authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === "square_not_connected" || body.error === "square_location_required") {
        const mock = await FloorSquare.authorize({
          accessToken: "sandbox",
          locationId: "sandbox",
          mock: true,
        });
        setAuthorized(mock.ok);
        setStatus(
          mock.ok
            ? "Mock reader ready (Connect Square + pick a location for live sandbox charges)."
            : `Authorize failed: ${mock.reason || "unknown"}`,
        );
        if (!mock.ok) setError(`Square authorize failed: ${mock.reason || "unknown"}`);
        return;
      }
      throw new Error(`square-mobile-auth HTTP ${res.status}: ${body.error || body.message || "unknown"}`);
    }
    const result = await FloorSquare.authorize({
      accessToken: body.accessToken,
      locationId: body.locationId,
      mock: !!body.sandbox && !body.accessToken,
    });
    if (!result.ok) throw new Error(result.reason || "authorize_failed");
    setAuthorized(true);
    setStatus(result.mock ? "Mock reader authorized" : "Square reader authorized");
    try {
      await FloorSquare.startPairing?.();
    } catch {
      /* optional */
    }
  }

  async function ensureDevice() {
    await ensureOnline();
    const sb = floorCloud();
    if (deviceId) {
      const { error: hbErr } = await sb.rpc("heartbeat_pos_device", { p_device_id: deviceId });
      if (hbErr) throw new Error(`Heartbeat failed: ${authErrorMessage(hbErr)}`);
      return deviceId;
    }
    const { data, error: rpcErr } = await sb.rpc("register_pos_reader", { p_label: "iPhone reader" });
    if (rpcErr) {
      throw new Error(
        `register_pos_reader failed: ${authErrorMessage(rpcErr)}. If this says the function is missing, migration 0025/0028 is not on Floor yet.`,
      );
    }
    const row = data as { id: string; pair_code: string };
    if (!row?.pair_code) throw new Error("register_pos_reader returned no pair_code");
    setDeviceId(row.id);
    setPairCode(row.pair_code);
    return row.id;
  }

  async function loadPending(id: string) {
    const { data, error: qErr } = await floorCloud()
      .from("card_charges")
      .select("id, sku, title, amount_cents, tax_cents")
      .eq("device_id", id)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (qErr) {
      throw new Error(`Pending charges query failed: ${authErrorMessage(qErr)}`);
    }
    setPending((data as typeof pending) ?? []);
  }

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        if (!online) {
          if (!stop) setError("Device offline — connect to Wi‑Fi to register as a reader.");
          return;
        }
        const id = await ensureDevice();
        if (stop) return;
        await loadPending(id);
        if (!stop) setError("");
      } catch (err) {
        if (!stop) setError(authErrorMessage(err));
      }
    }
    void tick();
    const t = setInterval(() => void tick(), 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [online, deviceId]);

  async function takePayment(charge: (typeof pending)[0]) {
    setError("");
    setStatus("Charging…");
    try {
      await ensureOnline();
      if (!authorized) await authorizeSdk();
      const result = await FloorSquare.charge({
        amountCents: charge.amount_cents,
        mock: !authorized,
      });
      if (!result.ok || !result.paymentId) {
        await floorCloud()
          .from("card_charges")
          .update({ status: "failed", error: result.reason || "declined", updated_at: new Date().toISOString() })
          .eq("id", charge.id);
        setError(result.reason || "Card declined");
        setStatus("");
        return;
      }
      const { error: capErr } = await floorCloud().rpc("capture_register_charge", {
        p_charge_id: charge.id,
        p_payment_id: result.paymentId,
        p_card_brand: result.cardBrand ?? null,
        p_card_last4: result.cardLast4 ?? null,
      });
      if (capErr) throw new Error(`capture_register_charge failed: ${authErrorMessage(capErr)}`);
      setStatus("Captured — register will finalize the ticket.");
      if (deviceId) await loadPending(deviceId);
    } catch (err) {
      setError(authErrorMessage(err));
      setStatus("");
    }
  }

  const storeLabel = session?.storeId ? session.storeId.slice(0, 8) : "—";

  return (
    <div className="p-4">
      <h1 className="text-title">Payment device</h1>
      <p className="text-quiet mt-1">
        Keep this screen open while the register charges cards. Store {storeLabel}…
      </p>
      <div className="mt-4 rounded-xl border border-floor-line bg-floor-panel px-4 py-5 text-center">
        <p className="text-quiet tracking-wide text-floor-mute">Pair code</p>
        <p className="mt-2 font-mono text-4xl font-bold tracking-[0.35em] text-floor-text">
          {pairCode || (error ? "———" : "······")}
        </p>
        {!pairCode && !error ? (
          <p className="text-quiet mt-2">Registering this phone as a reader…</p>
        ) : null}
      </div>
      {!session ? <Notice tone="error">Sign in required.</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {error ? (
        <button
          type="button"
          className="btn-text mt-1 px-0"
          onClick={() => {
            setDeviceId(null);
            setPairCode("");
            setError("");
          }}
        >
          Retry register reader
        </button>
      ) : null}
      {status ? <p className="text-quiet mt-2">{status}</p> : null}
      <div className="mt-4 flex gap-2">
        <button type="button" className="btn-accent" onClick={() => void authorizeSdk()}>
          Authorize Square
        </button>
      </div>
      <div className="mt-6">
        <Label>Pending charges</Label>
      </div>
      {!pending.length ? <p className="text-quiet mt-2">None — waiting for the register.</p> : null}
      <ul className="mt-2 space-y-2">
        {pending.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 border border-floor-line p-3">
            <div>
              <div className="text-body">{c.title || c.sku}</div>
              <div className="text-quiet text-sm">
                ${(c.amount_cents / 100).toFixed(2)} · tax ${(c.tax_cents / 100).toFixed(2)}
              </div>
            </div>
            <button type="button" className="btn-accent" onClick={() => void takePayment(c)}>
              Take payment
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
