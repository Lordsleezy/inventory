import { floorCloud } from "./client.ts";
import { assertOnline } from "./online.ts";
import { mapSellError, SellError } from "./sell.ts";

export type TicketLineInput = {
  sku: string;
  priceCents: number;
  overrideReason?: string | null;
  approvalId?: string | null;
};

export type TicketLineResult = {
  sale_id: number;
  sku: string;
  receipt_no: string;
  price_cents: number;
  tax_cents: number;
  list_price_cents: number | null;
  override_reason: string | null;
  payment_method?: string | null;
};

export type TicketSummary = {
  ticket_id: string;
  lines: TicketLineResult[];
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  payment_method?: string | null;
};

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
  await assertOnline();
  const { error } = await floorCloud().rpc("set_store_setting", {
    p_key: "taxRateBps",
    p_value: bps,
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
}): Promise<TicketSummary> {
  await assertOnline();
  const { data, error } = await floorCloud().rpc("finalize_ticket", {
    p_ticket_id: args.ticketId,
    p_lines: args.lines.map((l) => ({
      sku: l.sku,
      price_cents: l.priceCents,
      override_reason: l.overrideReason ?? null,
      approval_id: l.approvalId ?? null,
    })),
    p_payment_method: args.paymentMethod,
    p_payment_id: args.paymentId ?? null,
    p_amount_tendered_cents: args.amountTenderedCents ?? null,
    p_channel: args.channel ?? "floor",
  });
  if (error) throw mapSellError(error);
  return data as TicketSummary;
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
