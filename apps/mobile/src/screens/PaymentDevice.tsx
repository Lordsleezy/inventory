import { useEffect, useState } from "react";
import { floorCloud, authErrorMessage } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice } from "../components/ui";
import { FloorSquare } from "@floor/square-plugin";

/**
 * Phone acts as the card reader for the register.
 * Shows a pair code, heartbeats, and accepts pending card_charges.
 */
export function PaymentDeviceScreen() {
  const { session, online, ensureOnline } = useStore();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState("");
  const [pending, setPending] = useState<
    { id: string; sku: string; title: string | null; amount_cents: number; tax_cents: number }[]
  >([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

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
      // Mobile Payments SDK via plugin (sandbox / mock reader on simulator).
      const result = await FloorSquare.charge({ amountCents: charge.amount_cents });
      if (!result.ok || !result.paymentId) {
        await floorCloud()
          .from("card_charges")
          .update({ status: "failed", error: result.reason || "declined", updated_at: new Date().toISOString() })
          .eq("id", charge.id);
        setError(result.reason || "Card declined");
        setStatus("");
        return;
      }
      await floorCloud()
        .from("card_charges")
        .update({
          status: "captured",
          payment_id: result.paymentId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", charge.id);
      setStatus("Captured — register will finalize.");
      if (deviceId) await loadPending(deviceId);
    } catch (err) {
      setError(authErrorMessage(err));
      setStatus("");
    }
  }

  return (
    <div className="p-4">
      <h1 className="text-title">Payment device</h1>
      <p className="mt-1 text-quiet text-floor-mute">
        Store {session.storeId.slice(0, 8)}… · Show this code on the register Settings → Pair.
      </p>
      <p className="mt-4 text-center text-3xl font-bold tracking-widest">{pairCode || "……"}</p>
      <Notice tone="error">{error}</Notice>
      {status ? <p className="mt-2 text-quiet">{status}</p> : null}
      <Label>Pending charges</Label>
      <ul className="mt-2 space-y-2">
        {pending.map((c) => (
          <li key={c.id} className="border border-floor-line p-3">
            <div>
              SKU {c.sku} · {c.title || "Item"}
            </div>
            <div className="text-quiet">${(c.amount_cents / 100).toFixed(2)} (tax-included total)</div>
            <button type="button" className="btn-accent mt-2" onClick={() => void takePayment(c)}>
              Charge card
            </button>
          </li>
        ))}
        {!pending.length ? <li className="text-quiet text-floor-mute">No pending charges.</li> : null}
      </ul>
    </div>
  );
}
