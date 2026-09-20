import { floorCloud } from "@floor/cloud";
import { callFunction } from "./functions";
import { mapChargeStatus, readerIsFresh, type ChargeResult } from "./card-status";

export type { ChargeResult };
export { mapChargeStatus, readerIsFresh };

export type ChargeRequest = {
  reservationId: string;
  amountCents: number;
  taxCents: number;
  sku: string;
  title: string;
  actorId: string;
};

export type CardDeviceKind = "phone_reader" | "square_terminal";

export async function loadPairedReader(): Promise<{ id: string; lastSeen: string; kind: string } | null> {
  const sb = floorCloud();
  const { data: setting } = await sb.from("store_settings").select("value").eq("key", "pos_reader_device_id").maybeSingle();
  const id = typeof setting?.value === "string" ? setting.value.replace(/"/g, "") : setting?.value ? String(setting.value) : "";
  if (!id) return null;
  const { data } = await sb.from("pos_devices").select("id, last_seen, kind").eq("id", id).maybeSingle();
  if (!data) return null;
  return { id: data.id, lastSeen: data.last_seen, kind: data.kind };
}

export async function pairReader(code: string): Promise<string> {
  const { data, error } = await floorCloud().rpc("pair_pos_reader", { p_pair_code: code.trim().toUpperCase() });
  if (error) throw error;
  return String(data);
}

export async function unpairReader(): Promise<void> {
  const sb = floorCloud();
  const { data: session } = await sb.auth.getSession();
  const { data: staff } = await sb.from("staff").select("store_id").eq("user_id", session.session?.user.id ?? "").maybeSingle();
  if (!staff?.store_id) return;
  await sb.from("store_settings").delete().eq("store_id", staff.store_id).eq("key", "pos_reader_device_id");
}

export async function extendHold(reservationId: string): Promise<void> {
  await floorCloud().rpc("extend_reservation", { p_id: reservationId, p_seconds: 600 });
}

export async function sendCharge(kind: CardDeviceKind, req: ChargeRequest): Promise<ChargeResult> {
  if (kind === "square_terminal") return sendTerminalCharge(req);
  return sendPhoneCharge(req);
}

async function sendPhoneCharge(req: ChargeRequest): Promise<ChargeResult> {
  const reader = await loadPairedReader();
  if (!reader || !readerIsFresh(reader.lastSeen)) return { ok: false, reason: "not_paired" };
  const sb = floorCloud();
  const { data, error } = await sb
    .from("card_charges")
    .insert({
      device_id: reader.id,
      store_id: (await storeId()) ?? undefined,
      reservation_id: req.reservationId,
      sku: req.sku,
      title: req.title,
      amount_cents: req.amountCents,
      tax_cents: req.taxCents,
      actor_id: req.actorId,
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !data) return { ok: false, reason: "offline" };
  await extendHold(req.reservationId).catch(() => {});
  return waitForCharge(data.id);
}

async function storeId(): Promise<string | null> {
  const sb = floorCloud();
  const { data: session } = await sb.auth.getSession();
  const { data } = await sb.from("staff").select("store_id").eq("user_id", session.session?.user.id ?? "").maybeSingle();
  return data?.store_id ?? null;
}

export async function waitForCharge(chargeId: string, timeoutMs = 120_000): Promise<ChargeResult> {
  const started = Date.now();
  const sb = floorCloud();
  while (Date.now() - started < timeoutMs) {
    const { data } = await sb
      .from("card_charges")
      .select("status, payment_id, error")
      .eq("id", chargeId)
      .maybeSingle();
    const status = data?.status;
    if (status === "captured" && data?.payment_id) {
      return { ok: true, paymentId: data.payment_id, chargeId };
    }
    if (status === "finalized" && data?.payment_id) {
      return { ok: true, paymentId: data.payment_id, chargeId };
    }
    if (status === "failed") return { ok: false, reason: "declined" };
    if (status === "canceled") return { ok: false, reason: "canceled" };
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: false, reason: "timeout" };
}

async function sendTerminalCharge(req: ChargeRequest): Promise<ChargeResult> {
  const created = await callFunction("square-terminal-checkout", {
    method: "POST",
    body: JSON.stringify({
      reservationId: req.reservationId,
      amountCents: req.amountCents,
      sku: req.sku,
    }),
  });
  const body = await created.json();
  if (!created.ok) return { ok: false, reason: "offline" };
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    const res = await callFunction(`square-terminal-checkout?id=${encodeURIComponent(body.id)}`, { method: "GET" });
    const row = await res.json();
    const status = String(row.status || "").toUpperCase();
    if (status === "COMPLETED" && row.paymentId) return { ok: true, paymentId: String(row.paymentId), chargeId: body.id };
    if (status === "CANCELED" || status === "CANCEL_REQUESTED") return { ok: false, reason: "canceled" };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, reason: "timeout" };
}

export async function cancelCharge(chargeId: string): Promise<void> {
  await floorCloud().from("card_charges").update({ status: "canceled", updated_at: new Date().toISOString() }).eq("id", chargeId).eq("status", "pending");
}

export async function replayCapturedCharges(): Promise<{ id: string; sku: string; paymentId: string }[]> {
  const sb = floorCloud();
  const { data } = await sb.from("card_charges").select("id, sku, payment_id").eq("status", "captured");
  return (data ?? [])
    .filter((row) => row.payment_id)
    .map((row) => ({ id: row.id, sku: row.sku, paymentId: String(row.payment_id) }));
}

export async function finalizeCapturedCharge(chargeId: string) {
  const { data, error } = await floorCloud().rpc("finalize_register_charge", { p_charge_id: chargeId });
  if (error) throw error;
  return data as { receipt_no?: string; sku?: string };
}
