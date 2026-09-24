import { floorCloud } from "./client.ts";
import { assertOnline } from "./online.ts";
import { mapSellError, SellError } from "./sell.ts";

export type TicketLineInput = {
  sku: string;
  /** Unit price in cents. */
  priceCents: number;
  qty?: number;
  overrideReason?: string | null;
  approvalId?: string | null;
};

export type TicketLineResult = {
  sale_id: number;
  sku: string;
  receipt_no: string;
  price_cents: number;
  tax_cents: number;
  card_fee_cents?: number;
  list_price_cents: number | null;
  override_reason: string | null;
  payment_method?: string | null;
  card_brand?: string | null;
  card_last4?: string | null;
  qty?: number;
};

export type TicketSummary = {
  ticket_id: string;
  lines: TicketLineResult[];
  subtotal_cents: number;
  tax_cents: number;
  card_fee_bps?: number;
  card_fee_cents?: number;
  total_cents: number;
  payment_method?: string | null;
  card_brand?: string | null;
  card_last4?: string | null;
  discount_bps?: number;
  discount_cents?: number;
  signup_discount_cents?: number;
  points_redeemed?: number;
  points_earned?: number;
  points_balance?: number | null;
  customer_id?: string | null;
  customer?: {
    id: string;
    phone: string;
    name: string | null;
    email: string | null;
    points_balance?: number | null;
  } | null;
  cash_cents?: number;
  card_cents?: number;
  amount_tendered_cents?: number | null;
  note?: string | null;
};

/** Server-side quote incl. card fee; mirrors quote_ticket_totals. */
export type TicketQuote = {
  raw_subtotal_cents: number;
  discount_bps: number;
  discount_cents: number;
  signup_discount_cents: number;
  redeem_cents: number;
  subtotal_cents: number;
  tax_cents: number;
  pre_fee_total_cents: number;
  card_fee_bps: number;
  card_base_cents: number;
  card_fee_cents: number;
  card_charge_cents: number;
  total_cents: number;
};

/** Client preview only — server recomputes. Round-half-up like SQL round(). */
export function cardFeeCents(cardBaseCents: number, feeBps: number): number {
  const base = Math.max(0, Math.trunc(cardBaseCents) || 0);
  const bps = Math.max(0, Math.trunc(feeBps) || 0);
  return Math.round((base * bps) / 10_000);
}

export async function quoteTicketTotals(args: {
  lines: TicketLineInput[];
  discountBps?: number;
  customerId?: string | null;
  redeemPoints?: number;
  channel?: string;
  paymentMethod?: string;
  cashCents?: number | null;
}): Promise<TicketQuote> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("quote_ticket_totals", {
    p_lines: args.lines.map((l) => ({
      sku: l.sku,
      price_cents: l.priceCents,
      qty: l.qty ?? 1,
    })),
    p_discount_bps: args.discountBps ?? 0,
    p_customer_id: args.customerId ?? null,
    p_redeem_points: Math.round((args.redeemPoints ?? 0) * 10),
    p_channel: args.channel ?? "floor",
    p_payment_method: args.paymentMethod ?? "cash",
    p_cash_cents: args.cashCents ?? null,
  });
  if (error) throw mapSellError(error);
  return data as TicketQuote;
}

/** Client preview only — server recomputes in finalize_ticket. */
export function allocateLineTaxes(prices: number[], bps: number): number[] {
  if (!prices.length) return [];
  if (!Number.isFinite(bps) || bps < 0) throw new SellError("unknown", "Tax rate is not set.");
  const sum = prices.reduce((a, b) => a + b, 0);
  const ticket = Math.round((sum * bps) / 10_000);
  const lines: number[] = [];
  let acc = 0;
  for (let i = 0; i < prices.length; i++) {
    if (i === prices.length - 1) {
      lines.push(ticket - acc);
    } else {
      const line = Math.floor((prices[i] * bps) / 10_000);
      lines.push(line);
      acc += line;
    }
  }
  return lines;
}

/** Prorate a cent amount across line prices; floor shares, remainder on last. */
export function prorateCents(prices: number[], total: number): number[] {
  if (!prices.length) return [];
  const sum = prices.reduce((a, b) => a + b, 0);
  if (sum <= 0) return prices.map(() => 0);
  const out: number[] = [];
  let acc = 0;
  for (let i = 0; i < prices.length; i++) {
    if (i === prices.length - 1) {
      out.push(total - acc);
    } else {
      const share = Math.floor((prices[i] * total) / sum);
      out.push(share);
      acc += share;
    }
  }
  return out;
}

/**
 * Preview ticket % discount on line prices (before signup/redeem).
 * Returns discounted line totals plus the total discount cents.
 */
export function applyTicketDiscount(
  prices: number[],
  discountBps: number,
): { discounted: number[]; discountCents: number } {
  if (!prices.length) return { discounted: [], discountCents: 0 };
  const bps = Math.max(0, Math.min(10_000, Math.trunc(discountBps) || 0));
  const raw = prices.reduce((a, b) => a + b, 0);
  const discountCents = Math.round((raw * bps) / 10_000);
  const shares = prorateCents(prices, discountCents);
  return {
    discounted: prices.map((p, i) => Math.max(0, p - shares[i])),
    discountCents,
  };
}

export async function loadStoreTaxRateBps(): Promise<number | null> {
  await assertOnline();
  const sb = floorCloud();
  const { data: session } = await sb.auth.getSession();
  const uid = session.session?.user.id;
  if (!uid) return null;
  const { data: staff } = await sb.from("staff").select("store_id").eq("user_id", uid).maybeSingle();
  if (!staff?.store_id) return null;
  const { data } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", staff.store_id)
    .eq("key", "taxRateBps")
    .maybeSingle();
  if (data?.value == null) return null;
  const raw = typeof data.value === "number" ? data.value : Number(String(data.value).replace(/"/g, ""));
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

export async function setStoreTaxRateBps(bps: number): Promise<void> {
  await setStoreSetting("taxRateBps", bps);
}

export async function loadStoreCardFeeBps(): Promise<number> {
  const raw = await loadStoreSetting("card_fee_bps");
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").replace(/"/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : 250;
}

export async function loadStoreSetting(key: string): Promise<unknown | null> {
  await assertOnline();
  const sb = floorCloud();
  const { data: session } = await sb.auth.getSession();
  const uid = session.session?.user.id;
  if (!uid) return null;
  const { data: staff } = await sb.from("staff").select("store_id").eq("user_id", uid).maybeSingle();
  if (!staff?.store_id) return null;
  const { data } = await sb
    .from("store_settings")
    .select("value")
    .eq("store_id", staff.store_id)
    .eq("key", key)
    .maybeSingle();
  return data?.value ?? null;
}

export async function setStoreSetting(key: string, value: unknown): Promise<void> {
  await assertOnline();
  const { error } = await floorCloud().rpc("set_store_setting", {
    p_key: key,
    p_value: value,
  });
  if (error) throw error;
}

export async function finalizeTicket(args: {
  ticketId: string;
  lines: TicketLineInput[];
  paymentMethod: string;
  paymentId?: string | null;
  amountTenderedCents?: number | null;
  channel?: string;
  discountBps?: number;
  discountApprovalId?: string | null;
  customerId?: string | null;
  redeemPoints?: number;
  cashCents?: number | null;
  cardCents?: number | null;
  note?: string | null;
}): Promise<TicketSummary> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("finalize_ticket", {
    p_ticket_id: args.ticketId,
    p_lines: args.lines.map((l) => ({
      sku: l.sku,
      price_cents: l.priceCents,
      qty: l.qty ?? 1,
      override_reason: l.overrideReason ?? null,
      approval_id: l.approvalId ?? null,
    })),
    p_payment_method: args.paymentMethod,
    p_payment_id: args.paymentId ?? null,
    p_amount_tendered_cents: args.amountTenderedCents ?? null,
    p_channel: args.channel ?? "floor",
    p_discount_bps: args.discountBps ?? 0,
    p_discount_approval_id: args.discountApprovalId ?? null,
    p_customer_id: args.customerId ?? null,
    p_redeem_points: Math.round((args.redeemPoints ?? 0) * 10),
    p_cash_cents: args.cashCents ?? null,
    p_card_cents: args.cardCents ?? null,
    p_note: args.note ?? null,
  });
  if (error) throw mapSellError(error);
  const summary = data as TicketSummary;
  return {
    ...summary,
    points_earned: (summary.points_earned ?? 0) / 10,
    points_balance: summary.points_balance == null ? null : summary.points_balance / 10,
    customer: summary.customer
      ? { ...summary.customer, points_balance: (summary.customer.points_balance ?? 0) / 10 }
      : summary.customer,
  };
}

export async function voidTicket(ticketId: string, reason: string, approvalId?: string | null): Promise<void> {
  await assertOnline();
  const { error } = await floorCloud().rpc("void_ticket", {
    p_ticket_id: ticketId,
    p_reason: reason,
    p_approval_id: approvalId ?? null,
  });
  if (error) throw mapSellError(error);
}

export async function approveWithPin(action: string, sku: string, pin: string, ticketId?: string | null): Promise<string> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("approve_with_pin", {
    p_action: action,
    p_sku: sku,
    p_pin: pin,
    p_ticket_id: ticketId ?? null,
  });
  if (error) throw mapSellError(error);
  return String(data);
}
