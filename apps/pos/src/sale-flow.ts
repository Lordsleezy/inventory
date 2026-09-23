import { formatCentsTotal } from "@floor/store";
import type { TicketSummary } from "@floor/cloud";
import { printReceipt } from "./print-receipt";
import type { ReceiptBranding, ReceiptPayload } from "./receipt";
import type { PosSettings, PrintResult } from "./local";
import { callFunction } from "./functions";
import {
  cancelCharge,
  createTicketCharge,
  finalizeCapturedCharge,
  loadOrphanCharge,
  refundFailedCharge,
  waitForCharge,
  type CreateChargeOpts,
  type TicketLineForCharge,
} from "./card-device";

export type SalePhase = "idle" | "waiting_phone" | "finalizing" | "recovering";

export function ticketReceiptPayload(
  summary: TicketSummary,
  meta: {
    clerkName: string;
    changeCents: number | null;
    titles: Record<string, { title: string; condition: string | null }>;
    reviewUrl: string | null;
    legal: string;
    cashTenderedCents?: number | null;
    branding?: ReceiptBranding | null;
  },
): ReceiptPayload {
  const first = summary.lines[0];
  const method = (summary.payment_method || "cash").toUpperCase();
  const cardBits = [summary.card_brand, summary.card_last4 ? `•••• ${summary.card_last4}` : null]
    .filter(Boolean)
    .join(" ");
  const tenderLabel =
    method +
    (cardBits ? ` · ${cardBits}` : "") +
    (meta.changeCents != null ? ` · change ${formatCentsTotal(meta.changeCents)}` : "");
  const lineDiscount = summary.lines.reduce((sum, l) => {
    const list = l.list_price_cents;
    if (list != null && list > l.price_cents) return sum + (list - l.price_cents);
    return sum;
  }, 0);
  const discountCents =
    (summary.discount_cents ?? 0) + (summary.signup_discount_cents ?? 0) ||
    (lineDiscount > 0 ? lineDiscount : null);
  return {
    receiptNo: first?.receipt_no || summary.ticket_id.slice(0, 8),
    soldAt: new Date().toLocaleString(),
    clerkName: meta.clerkName,
    sku: summary.lines.map((l) => l.sku).join(", "),
    title: summary.lines
      .map((l) => `${l.sku} ${meta.titles[l.sku]?.title || ""} ${formatCentsTotal(l.price_cents)}`)
      .join("\n"),
    condition: null,
    priceCents: summary.subtotal_cents,
    taxCents: summary.tax_cents,
    totalCents: summary.total_cents,
    subtotalCents: summary.subtotal_cents,
    cardFeeCents: summary.card_fee_cents ?? null,
    tender: tenderLabel,
    tenderDetails: {
      method,
      cardBrand: summary.card_brand ?? null,
      cardLast4: summary.card_last4 ?? null,
      cashTenderedCents: meta.cashTenderedCents ?? summary.cash_cents ?? null,
      changeCents: meta.changeCents,
      cashCents: method === "SPLIT" ? (summary.cash_cents ?? null) : null,
      cardCents:
        method === "SPLIT" || method === "CARD" ? (summary.card_cents ?? null) : null,
    },
    discountCents: discountCents && discountCents > 0 ? discountCents : null,
    pointsEarned: summary.points_earned ?? null,
    pointsRedeemed: summary.points_redeemed ?? null,
    pointsBalance:
      summary.points_balance ??
      summary.customer?.points_balance ??
      null,
    reviewUrl: meta.reviewUrl,
    legal: meta.legal,
    branding: meta.branding,
    lines: summary.lines.map((l) => ({
      sku: l.sku,
      title: meta.titles[l.sku]?.title || "Item",
      condition: meta.titles[l.sku]?.condition ?? null,
      priceCents: l.price_cents,
      taxCents: l.tax_cents,
      listPriceCents: l.list_price_cents ?? null,
    })),
  };
}

export async function printTicketReceipt(
  summary: TicketSummary,
  meta: Parameters<typeof ticketReceiptPayload>[1],
  settings: PosSettings,
): Promise<PrintResult> {
  return printReceipt(ticketReceiptPayload(summary, meta), settings, meta.branding);
}

export async function withdrawListingsAfterSale(skus: string[]): Promise<void> {
  for (const sku of skus) {
    try {
      await callFunction("ebay-withdraw", {
        method: "POST",
        body: JSON.stringify({ afterSale: true, sku }),
      });
    } catch {
      /* sync later */
    }
  }
}

export async function runCardChargeFlow(args: {
  ticketId: string;
  lines: TicketLineForCharge[];
  chargeOpts?: CreateChargeOpts;
  signal?: AbortSignal;
  onHint?: (hint: string) => void;
}): Promise<
  | { ok: true; summary: TicketSummary; paymentId: string; chargeId: string }
  | { ok: false; error: string; loud?: string }
> {
  const { ticketId, lines, chargeOpts, signal, onHint } = args;
  let chargeId: string | null = null;
  let paymentId: string | null = null;
  try {
    onHint?.("Sending charge to the phone reader…");
    const created = await createTicketCharge(ticketId, lines, chargeOpts);
    chargeId = created.id;

    if (created.status === "finalized" && created.summary) {
      return {
        ok: true,
        summary: created.summary as TicketSummary,
        paymentId: "",
        chargeId,
      };
    }

    onHint?.(
      `Waiting on phone — charge ${formatCentsTotal(created.amountCents)}. Customer can tap/insert on the reader.`,
    );
    const paid = await waitForCharge(chargeId, { signal, timeoutMs: 180_000 });
    if (!paid.ok) {
      if (paid.reason === "canceled") return { ok: false, error: "Card payment canceled." };
      if (paid.reason === "failed") {
        return {
          ok: false,
          error: paid.error
            ? `Card failed on phone: ${paid.error}`
            : "Card declined. Nothing was sold.",
        };
      }
      if (paid.reason === "timeout") {
        await cancelCharge(chargeId).catch(() => {});
        return { ok: false, error: "Timed out waiting for the phone. Nothing was sold." };
      }
      return { ok: false, error: paid.error || "Card payment failed. Nothing was sold." };
    }
    paymentId = paid.paymentId;

    onHint?.("Card captured — recording the sale…");
    const summary = (await finalizeCapturedCharge(chargeId)) as TicketSummary & {
      ok?: boolean;
      error?: string;
      needs_refund?: boolean;
      payment_id?: string;
      amount_cents?: number;
    };
    if (summary && summary.ok === false) {
      try {
        await refundFailedCharge({
          chargeId,
          paymentId: summary.payment_id || paymentId,
          amountCents: summary.amount_cents || created.amountCents,
          reason: String(summary.error || "finalize_failed"),
        });
        return {
          ok: false,
          error: "",
          loud: `Sale could not finish (${summary.error || "error"}). The card payment was refunded. Inventory was not marked sold.`,
        };
      } catch (refundErr) {
        return {
          ok: false,
          error: "",
          loud: `Sale failed after card capture, and automatic refund failed. Check Square Dashboard for payment ${paymentId}. ${
            refundErr instanceof Error ? refundErr.message : String(refundErr)
          }`,
        };
      }
    }
    return { ok: true, summary: summary as TicketSummary, paymentId, chargeId };
  } catch (err) {
    if (chargeId) await cancelCharge(chargeId).catch(() => {});
    throw err;
  }
}

export { cancelCharge, refundFailedCharge, finalizeCapturedCharge };

/**
 * Crash/restart recovery: a charge that captured on the phone but never
 * finalized is either finished (sale recorded) or refunded in full so the
 * register never silently keeps a card charge without a sale.
 */
export async function recoverOrphanCharge(): Promise<
  | { kind: "none" }
  | { kind: "finalized"; summary: TicketSummary }
  | { kind: "refunded"; amountCents: number }
  | { kind: "needs_attention"; message: string }
> {
  const orphan = await loadOrphanCharge().catch(() => null);
  if (!orphan) return { kind: "none" };
  if (orphan.status === "finalize_failed") {
    try {
      await refundFailedCharge({
        chargeId: orphan.id,
        paymentId: orphan.paymentId,
        amountCents: orphan.amountCents,
        reason: "finalize_failed_recovery",
      });
      return { kind: "refunded", amountCents: orphan.amountCents };
    } catch (err) {
      return {
        kind: "needs_attention",
        message: `Card charge ${orphan.id.slice(0, 8)} needs a refund. Check Square Dashboard for payment ${orphan.paymentId ?? "?"}. ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
  try {
    const summary = (await finalizeCapturedCharge(orphan.id)) as TicketSummary & {
      ok?: boolean;
      error?: string;
      payment_id?: string;
      amount_cents?: number;
    };
    if (summary && summary.ok === false) {
      try {
        await refundFailedCharge({
          chargeId: orphan.id,
          paymentId: summary.payment_id || orphan.paymentId,
          amountCents: summary.amount_cents || orphan.amountCents,
          reason: String(summary.error || "finalize_failed_recovery"),
        });
        return { kind: "refunded", amountCents: orphan.amountCents };
      } catch (refundErr) {
        return {
          kind: "needs_attention",
          message: `Captured charge could not finalize or refund. Payment ${orphan.paymentId ?? "?"}. ${
            refundErr instanceof Error ? refundErr.message : String(refundErr)
          }`,
        };
      }
    }
    return { kind: "finalized", summary: summary as TicketSummary };
  } catch (err) {
    return {
      kind: "needs_attention",
      message: `Could not finish captured charge: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
