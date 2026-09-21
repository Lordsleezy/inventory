/** Must stay aligned with create_register_charge reader_offline window (45s). */
const HEARTBEAT_MS = 45_000;

export function readerIsFresh(lastSeen: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeen) return false;
  return now - new Date(lastSeen).getTime() < HEARTBEAT_MS;
}

export type ChargeResult =
  | { ok: true; paymentId: string; chargeId: string }
  | {
      ok: false;
      reason: "canceled" | "timeout" | "offline" | "not_paired" | "failed";
      chargeId?: string;
      error?: string;
    };

export function mapChargeStatus(status: string, paymentId: string | null, error?: string | null): ChargeResult {
  if ((status === "captured" || status === "finalized") && paymentId) {
    return { ok: true, paymentId, chargeId: "" };
  }
  if (status === "failed") return { ok: false, reason: "failed", error: error || undefined };
  if (status === "canceled") return { ok: false, reason: "canceled" };
  return { ok: false, reason: "timeout" };
}
