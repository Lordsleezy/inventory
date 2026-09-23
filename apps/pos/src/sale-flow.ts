import { formatCentsTotal } from "@floor/store";
import type { TicketSummary } from "@floor/cloud";
import { printReceipt } from "./print-receipt";
import type { ReceiptBranding, ReceiptPayload } from "./receipt";
import type { PosSettings, PrintResult } from "./local";
import { callFunction } from "./functions";
export type SalePhase = "idle" | "quoting" | "manual_card" | "finalizing";

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
