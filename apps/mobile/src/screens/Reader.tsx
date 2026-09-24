import { useEffect, useState } from "react";
import { formatCentsTotal } from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { FloorSquare } from "@floor/square-plugin";
import { functionsUrl, authHeader } from "../functions";
import { Label, Notice } from "../components/ui";
import { useStore } from "../store";

const DEVICE_KEY = "floor.readerDeviceId";
const CODE_KEY = "floor.readerPairCode";

type Incoming = {
  id: string;
  sku: string;
  title: string | null;
  amount_cents: number;
  status: string;
};

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

export function ReaderScreen() {
  const { session, cardPayments } = useStore();
  const [code, setCode] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let id = localStorage.getItem(DEVICE_KEY);
    let pair = localStorage.getItem(CODE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    if (!pair) {
      pair = randomCode();
      localStorage.setItem(CODE_KEY, pair);
    }
    setDeviceId(id);
    setCode(pair);
  }, []);

  useEffect(() => {
    if (!deviceId || !code) return;
    let wake: WakeLockSentinel | undefined;
    void navigator.wakeLock?.request("screen").then((lock) => {
      wake = lock;
    }).catch(() => {});
    const beat = () =>
      floorCloud().rpc("heartbeat_pos_device", {
        p_id: deviceId,
        p_pair_code: code,
        p_kind: "phone_reader",
        p_display_name: session.displayName || "Phone reader",
      });
    void beat();
    const t = setInterval(() => void beat(), 8000);
    return () => {
      clearInterval(t);
      void wake?.release();
    };
  }, [deviceId, code, session.displayName]);

  useEffect(() => {
    if (!deviceId) return;
    const sb = floorCloud();
    const channel = sb
      .channel(`reader-${deviceId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "card_charges", filter: `device_id=eq.${deviceId}` },
        (payload) => {
          const row = (payload.new || payload.old) as Incoming | undefined;
          if (row && (row.status === "pending" || row.status === "accepted")) setIncoming(row);
          if (row && ["captured", "failed", "canceled", "finalized"].includes(row.status)) setIncoming(null);
        },
      )
      .subscribe();
    const poll = setInterval(() => {
      void sb
        .from("card_charges")
        .select("id, sku, title, amount_cents, status")
        .eq("device_id", deviceId)
        .in("status", ["pending", "accepted"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
        .then(({ data }) => setIncoming((data as Incoming | null) ?? null));
    }, 2000);
    return () => {
      clearInterval(poll);
      void sb.removeChannel(channel);
    };
  }, [deviceId]);

  async function startCharge() {
    if (!incoming) return;
    setBusy(true);
    setError("");
    try {
      await floorCloud().from("card_charges").update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", incoming.id).eq("status", "pending");
      const headers = await authHeader();
      const tokenRes = await fetch(functionsUrl("square-mobile-token"), { headers });
      const tokenBody = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(tokenBody.error || "square_not_connected");
      const auth = await FloorSquare.authorize({ accessToken: tokenBody.accessToken, locationId: tokenBody.locationId });
      if (!auth.ok) throw new Error(auth.reason || "authorize failed");
      const charged = await FloorSquare.charge({ amountCents: incoming.amount_cents, idempotencyKey: incoming.id });
      if (!charged.ok || !charged.paymentId) {
        await floorCloud()
          .from("card_charges")
          .update({
            status: charged.reason === "canceled" ? "canceled" : "failed",
            error: charged.reason || "declined",
            updated_at: new Date().toISOString(),
          })
          .eq("id", incoming.id);
        setIncoming(null);
        setError(charged.reason === "canceled" ? "Canceled." : "Card declined.");
        return;
      }
      await floorCloud()
        .from("card_charges")
        .update({ status: "captured", payment_id: charged.paymentId, updated_at: new Date().toISOString() })
        .eq("id", incoming.id);
      setIncoming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelIncoming() {
    if (!incoming) return;
    await floorCloud()
      .from("card_charges")
      .update({ status: "canceled", updated_at: new Date().toISOString() })
      .eq("id", incoming.id)
      .in("status", ["pending", "accepted"]);
    setIncoming(null);
  }

  return (
    <section>
      <h1 className="text-title">Payment device</h1>
      <p className="text-quiet">This phone is a Square Reader for the iMac register. It does not create sales or receipts.</p>
      {!cardPayments ? <Notice tone="error">Connect Square in Setup → Connections.</Notice> : null}
      <Notice tone="error">{error}</Notice>
      <label className="block py-3">
        <Label>Pairing code — type this on the iMac</Label>
        <p className="text-title tracking-[0.3em]">{code}</p>
      </label>
      {incoming ? (
        <div className="border border-floor-line p-4">
          <p className="text-quiet">Incoming charge</p>
          <p className="text-title">{formatCentsTotal(incoming.amount_cents)}</p>
          <p>SKU {incoming.sku}</p>
          <p className="text-quiet">{incoming.title}</p>
          <button type="button" className="btn-accent mt-3" disabled={busy} onClick={() => void startCharge()}>
            {busy ? "Waiting for card…" : "Start"}
          </button>
          <button type="button" className="mt-2" disabled={busy} onClick={() => void cancelIncoming()}>
            Cancel
          </button>
        </div>
      ) : (
        <p className="text-quiet">Waiting for the register. Keep this screen open.</p>
      )}
    </section>
  );
}
