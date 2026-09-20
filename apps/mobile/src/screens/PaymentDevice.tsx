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
    if (!token) throw new Error("not_signed_in");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  async function authorizeSdk() {
    await ensureOnline();
    const res = await fetch(functionsUrl("square-mobile-auth"), { headers: await authHeaders() });
    const body = await res.json();
    if (!res.ok) {
      // Sandbox without OAuth: allow mock reader path.
      if (body.error === "square_not_connected" || body.error === "square_location_required") {
        const mock = await FloorSquare.authorize({
          accessToken: "sandbox",
          locationId: "sandbox",
          mock: true,
        });
        setAuthorized(mock.ok);
        setStatus(mock.ok ? "Mock reader ready (Square not connected — sandbox stub)." : "Authorize failed");
        return;
      }
      throw new Error(body.error || "auth_failed");
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
      await sb.rpc("heartbeat_pos_device", { p_device_id: deviceId });
      return deviceId;
    }
    const { data, error: rpcErr } = await sb.rpc("register_pos_reader", { p_label: "iPhone reader" });
    if (rpcErr) throw rpcErr;
    const row = data as { id: string; pair_code: string };
    setDeviceId(row.id);
    setPairCode(row.pair_code);
    return row.id;
  }

  async function loadPending(id: string) {
    const { data } = await floorCloud()
      .from("card_charges")
      .select("id, sku, title, amount_cents, tax_cents")
      .eq("device_id", id)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    setPending((data as typeof pending) ?? []);
  }

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        if (!online) return;
        const id = await ensureDevice();
        if (stop) return;
        await loadPending(id);
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
      if (capErr) throw capErr;
      setStatus("Captured — register will finalize the ticket.");
      if (deviceId) await loadPending(deviceId);
    } catch (err) {
      setError(authErrorMessage(err));
      setStatus("");
    }
  }

  return (
    <div className="p-4">
      <h1 className="text-title">Payment device</h1>
      <p className="text-quiet mt-1">
        Keep this screen open while the register charges cards. Pair code:{" "}
        <strong className="font-mono tracking-widest">{pairCode || "…"}</strong>
      </p>
      {!session ? <Notice>Sign in required.</Notice> : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {status ? <p className="text-quiet mt-2">{status}</p> : null}
      <div className="mt-4 flex gap-2">
        <button type="button" className="btn" onClick={() => void authorizeSdk()}>
          Authorize Square
        </button>
      </div>
      <Label className="mt-6">Pending charges</Label>
      {!pending.length ? <p className="text-quiet">None — waiting for the register.</p> : null}
      <ul className="mt-2 space-y-2">
        {pending.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-line p-3">
            <div>
              <div className="font-medium">{c.title || c.sku}</div>
              <div className="text-quiet text-sm">
                ${(c.amount_cents / 100).toFixed(2)} · tax ${(c.tax_cents / 100).toFixed(2)}
              </div>
            </div>
            <button type="button" className="btn btn-primary" onClick={() => void takePayment(c)}>
              Take payment
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
