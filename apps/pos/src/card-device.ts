import { floorCloud } from "@floor/cloud";
import { callFunction } from "./functions";
import { mapChargeStatus, readerIsFresh, type ChargeResult } from "./card-status";

export type { ChargeResult };
export { mapChargeStatus, readerIsFresh };

export type TicketLineForCharge = {
  sku: string;
  priceCents: number;
  qty?: number;
  overrideReason?: string | null;
  approvalId?: string | null;
};

export type CardDeviceKind = "phone_reader" | "square_terminal";

export async function loadPairedReader(): Promise<{
  id: string;
  lastSeen: string;
  kind: string;
  squareAuthorized: boolean;
  squareLocationId: string | null;
} | null> {
  const sb = floorCloud();
  const { data: setting } = await sb.from("store_settings").select("value").eq("key", "pos_reader_device_id").maybeSingle();
  const raw = setting?.value;
  const id =
    typeof raw === "string"
      ? raw.replace(/^"|"$/g, "")
      : raw != null
        ? String(raw).replace(/^"|"$/g, "")
        : "";
  if (!id) return null;
  const { data } = await sb
    .from("pos_devices")
    .select("id, last_seen, kind, square_authorized, square_location_id")
    .eq("id", id)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    lastSeen: data.last_seen,
    kind: data.kind,
    squareAuthorized: Boolean(data.square_authorized),
    squareLocationId: data.square_location_id ?? null,
  };
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

export type CreatedCharge = {
  id: string;
  ticketId: string;
  amountCents: number;
  taxCents: number;
  status: string;
  summary?: unknown;
};

export type CreateChargeOpts = {
  /** When set, charge only this amount (split payment card portion). */
  chargeCents?: number | null;
  discountBps?: number;
  discountApprovalId?: string | null;
  customerId?: string | null;
  redeemPoints?: number;
  cashCents?: number | null;
  cardCents?: number | null;
  note?: string | null;
};

/** Server computes tax-included total from lines (or uses chargeCents override). */
export async function createTicketCharge(
  ticketId: string,
  lines: TicketLineForCharge[],
  opts: CreateChargeOpts = {},
): Promise<CreatedCharge> {
  const reader = await loadPairedReader();
  if (!reader) {
    const err = new Error("reader_not_paired");
    (err as Error & { code: string }).code = "reader_not_paired";
    throw err;
  }
  if (!readerIsFresh(reader.lastSeen)) {
    const err = new Error("reader_offline");
    (err as Error & { code: string }).code = "reader_offline";
    throw err;
  }
  if (!reader.squareAuthorized) {
    const err = new Error("reader_not_authorized");
    (err as Error & { code: string }).code = "reader_not_authorized";
    throw err;
  }
  const payload: Record<string, unknown> = {
    p_ticket_id: ticketId,
    p_device_id: reader.id,
    p_lines: lines.map((l) => ({
      sku: l.sku,
      price_cents: l.priceCents,
      qty: l.qty ?? 1,
      override_reason: l.overrideReason ?? null,
      approval_id: l.approvalId ?? null,
    })),
  };
  if (opts.chargeCents != null) payload.p_charge_cents = opts.chargeCents;
  if (opts.discountBps != null) payload.p_discount_bps = opts.discountBps;
  if (opts.discountApprovalId != null) payload.p_discount_approval_id = opts.discountApprovalId;
  if (opts.customerId != null) payload.p_customer_id = opts.customerId;
  if (opts.redeemPoints != null) payload.p_redeem_points = opts.redeemPoints;
  if (opts.cashCents != null) payload.p_cash_cents = opts.cashCents;
  if (opts.cardCents != null) payload.p_card_cents = opts.cardCents;
  if (opts.note != null) payload.p_note = opts.note;

  const { data, error } = await floorCloud().rpc("create_register_charge", payload);
  if (error) throw error;
  const row = data as {
    id: string;
    ticket_id: string;
    amount_cents: number;
    tax_cents: number;
    status: string;
    summary?: unknown;
  };
  return {
    id: row.id,
    ticketId: row.ticket_id,
    amountCents: row.amount_cents,
    taxCents: row.tax_cents,
    status: row.status,
    summary: row.summary,
  };
}

export async function waitForCharge(
  chargeId: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<
  | { ok: true; paymentId: string; chargeId: string; cardBrand?: string | null; cardLast4?: string | null }
  | { ok: false; reason: "canceled" | "timeout" | "failed"; chargeId: string; error?: string }
> {
  const timeoutMs = opts?.timeoutMs ?? 180_000;
  const started = Date.now();
  const sb = floorCloud();
  while (Date.now() - started < timeoutMs) {
    if (opts?.signal?.aborted) return { ok: false, reason: "canceled", chargeId };
    const { data } = await sb
      .from("card_charges")
      .select("status, payment_id, error, card_brand, card_last4")
      .eq("id", chargeId)
      .maybeSingle();
    const status = data?.status;
    if (status === "captured" && data?.payment_id) {
      return {
        ok: true,
        paymentId: data.payment_id,
        chargeId,
        cardBrand: data.card_brand,
        cardLast4: data.card_last4,
      };
    }
    if (status === "finalized" && data?.payment_id) {
      return {
        ok: true,
        paymentId: data.payment_id,
        chargeId,
        cardBrand: data.card_brand,
        cardLast4: data.card_last4,
      };
    }
    if (status === "failed") {
      const detail = (data?.error || "").trim();
      return {
        ok: false,
        reason: "failed",
        chargeId,
        error: detail || "Card payment failed on the phone.",
      };
    }
    if (status === "canceled") return { ok: false, reason: "canceled", chargeId };
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: false, reason: "timeout", chargeId };
}

export async function cancelCharge(chargeId: string): Promise<void> {
  await floorCloud().rpc("cancel_register_charge", { p_charge_id: chargeId });
}

export async function finalizeCapturedCharge(chargeId: string) {
  const { data, error } = await floorCloud().rpc("finalize_register_charge", { p_charge_id: chargeId });
  if (error) throw error;
  return data;
}

/** Refund Square payment after capture when ticket cannot finalize. */
export async function refundFailedCharge(args: {
  chargeId: string;
  paymentId?: string | null;
  amountCents?: number;
  reason: string;
}): Promise<void> {
  await callFunction("square-refund-payment", {
    method: "POST",
    body: JSON.stringify({
      chargeId: args.chargeId,
      paymentId: args.paymentId,
      amountCents: args.amountCents,
      reason: args.reason,
    }),
  });
}

export async function sendTerminalCharge(): Promise<ChargeResult> {
  return { ok: false, reason: "offline" };
}
