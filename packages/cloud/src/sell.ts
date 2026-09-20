import { floorCloud } from "./client.ts";
import { assertOnline } from "./online.ts";

export type SellErrorCode =
  | "double_sell"
  | "below_floor"
  | "reservation_expired"
  | "not_sellable"
  | "tax_rate_required"
  | "override_reason_required"
  | "offline"
  | "unknown";

export class SellError extends Error {
  code: SellErrorCode;
  constructor(code: SellErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SellError";
  }
}

export function mapSellError(err: { code?: string; message?: string } | null | undefined): SellError {
  const message = err?.message ?? "Sale failed";
  const pg = err?.code ?? "";
  if (pg === "23505" || /unit_not_sellable|duplicate key|double_sell/i.test(message)) {
    return new SellError("double_sell", "DOUBLE SALE — this SKU already has a live sale. Do not take money.");
  }
  if (/below_floor/i.test(message)) {
    return new SellError("below_floor", "That price is below floor. A manager PIN is required.");
  }
  if (/tax_rate_required/i.test(message)) {
    return new SellError("tax_rate_required", "Set your tax rate in Settings before ringing up sales.");
  }
  if (/override_reason_required/i.test(message)) {
    return new SellError("override_reason_required", "Enter a reason when the price differs from ask.");
  }
  if (/reservation_expired/i.test(message)) {
    return new SellError("reservation_expired", "The hold expired. Start checkout again.");
  }
  if (/unit_not_sellable|sku_not_in_store|duplicate_sku/i.test(message)) {
    return new SellError("not_sellable", message);
  }
  return new SellError("unknown", message);
}

/** Drop cost/floor so the on-device cache cannot store them. */
export function stripCostFromUnit(row: Record<string, unknown>): Record<string, unknown> {
  const {
    acquisition_cost_cents: _c,
    floor_cents: _f,
    acquisitionCostCents: _c2,
    floorCents: _f2,
    ...rest
  } = row;
  return { ...rest, acquisitionCostCents: null, floorCents: null };
}

export async function reserveUnit(sku: string, channel: string) {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("reserve_unit", {
    p_sku: sku,
    p_channel: channel,
  });
  if (error) throw mapSellError(error);
  return data as { id: string; expires_at: string };
}

export async function finalizeSale(args: {
  sku: string;
  channel: string;
  priceCents: number;
  paymentMethod: string;
  paymentId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  note?: string | null;
  reservationId?: string | null;
  taxCents: number;
  approvalId?: string | null;
}) {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("finalize_sale", {
    p_sku: args.sku,
    p_channel: args.channel,
    p_price_cents: args.priceCents,
    p_payment_method: args.paymentMethod,
    p_payment_id: args.paymentId ?? null,
    p_customer_name: args.customerName ?? null,
    p_customer_phone: args.customerPhone ?? null,
    p_customer_email: args.customerEmail ?? null,
    p_note: args.note ?? null,
    p_reservation_id: args.reservationId ?? null,
    p_tax_cents: args.taxCents,
    p_approval_id: args.approvalId ?? null,
  });
  if (error) throw mapSellError(error);
  return data;
}

export async function releaseReservation(id: string) {
  try {
    await floorCloud().rpc("release_reservation", { p_id: id });
  } catch {
    /* hold already gone */
  }
}
