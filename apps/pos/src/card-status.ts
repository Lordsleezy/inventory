const HEARTBEAT_MS = 20_000;

export function readerIsFresh(lastSeen: string | null | undefined, now = Date.now()): boolean {
  if (!lastSeen) return false;
  return now - new Date(lastSeen).getTime() < HEARTBEAT_MS;
}

export type ChargeResult =
  | { ok: true; paymentId: string; chargeId: string }
  | { ok: false; reason: "declined" | "canceled" | "timeout" | "offline" | "not_paired" };

export function mapChargeStatus(status: string, paymentId: string | null): ChargeResult {
  if ((status === "captured" || status === "finalized") && paymentId) {
    return { ok: true, paymentId, chargeId: "" };
  }
  if (status === "failed") return { ok: false, reason: "declined" };
  if (status === "canceled") return { ok: false, reason: "canceled" };
  return { ok: false, reason: "timeout" };
}
