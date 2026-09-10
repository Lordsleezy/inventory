import type { Cents } from "./money.ts";
import { formatUsd } from "./money.ts";
import type { FloorConfig } from "./config.ts";
import type { SaleLine, SaleReceipt, SaleReceiptLine } from "./sale.ts";

export const MISSING_CONDITION = "Condition not recorded";
export const RECEIPT_TIME_ZONE = "America/Los_Angeles";

export type ReceiptCustomer = {
  name: string | null;
  email: string | null;
};

export type CustomerReceiptLine = {
  sku: string;
  brand: string;
  model: string;
  description: string;
  condition: string;
  priceCents: Cents;
  priceLabel: string;
};

export type CustomerReceipt = {
  storeName: string;
  storeAddress: string;
  storeEmail: string | null;
  reference: string;
  soldOnIso: string;
  soldOnLabel: string;
  customer: ReceiptCustomer | null;
  lines: CustomerReceiptLine[];
  subtotalCents: Cents;
  subtotalLabel: string;
  saleDiscountCents: Cents;
  saleDiscountLabel: string;
  taxCents: Cents;
  taxRateBps: number;
  taxRateLabel: string;
  taxLineLabel: string;
  taxAmountLabel: string;
  totalCents: Cents;
  totalLabel: string;
  paymentMethod: string | null;
  channel: string | null;
  returnPolicy: string;
};

type LineHint = Pick<SaleLine, "sku" | "brand" | "model" | "description" | "condition" | "title">;

export function formatTaxRateBps(bps: number): string {
  const pct = bps / 100;
  if (!Number.isFinite(pct) || pct < 0) return "0%";
  if (Number.isInteger(pct)) return `${pct}%`;
  return `${pct.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

export function taxLineLabel(bps: number): string {
  return `Tax (${formatTaxRateBps(bps)})`;
}

export function receiptDateStamp(iso: string, timeZone = RECEIPT_TIME_ZONE): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function receiptSoldOnLabel(iso: string, timeZone = RECEIPT_TIME_ZONE): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export function receiptPdfFilename(reference: string, soldOn: string, timeZone = RECEIPT_TIME_ZONE): string {
  const ref = (reference.trim() || "receipt").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "receipt";
  return `receipt-${ref}-${receiptDateStamp(soldOn, timeZone)}.pdf`;
}

export function receiptCustomer(customer: {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
} | null | undefined): ReceiptCustomer | null {
  const name = customer?.name?.trim() || null;
  const email = customer?.email?.trim() || null;
  if (!name && !email) return null;
  return { name, email };
}

function conditionLabel(raw: string | null | undefined): string {
  const value = raw?.trim();
  return value || MISSING_CONDITION;
}

function channelLabel(channel: string | null | undefined, config: FloorConfig): string | null {
  const id = channel?.trim();
  if (!id) return null;
  const match = config.channels.find((row) => row.id === id);
  if (match?.label) return match.label;
  if (id === "floor") return "In-store";
  if (id === "other") return "Other";
  return id;
}

function paymentLabel(receipt: SaleReceipt): string | null {
  const last = receipt.payments.at(-1);
  const method = last?.method?.trim();
  if (!method) return null;
  const match = method.toLowerCase();
  if (match === "cash") return "Cash";
  if (match === "card") return "Card";
  if (match === "other") return "Other";
  return method;
}

function mergeLine(line: SaleReceiptLine, hints: Map<string, LineHint>): CustomerReceiptLine {
  const hint = hints.get(line.sku);
  const brand = (line.brand ?? hint?.brand ?? "").trim();
  const model = (line.model ?? hint?.model ?? "").trim();
  const description = (line.description ?? hint?.description ?? line.title ?? hint?.title ?? "").trim();
  return {
    sku: line.sku,
    brand,
    model,
    description,
    condition: conditionLabel(line.condition ?? hint?.condition),
    priceCents: line.priceCents,
    priceLabel: formatUsd(line.priceCents),
  };
}

export function buildCustomerReceipt(
  receipt: SaleReceipt,
  config: FloorConfig,
  liveLines: LineHint[] = [],
): CustomerReceipt {
  const hints = new Map(liveLines.map((row) => [row.sku, row]));
  const customer = receiptCustomer(receipt.customer);
  const soldOnIso = receipt.soldOn || "";
  return {
    storeName: config.storeName,
    storeAddress: config.storeAddress,
    storeEmail: config.storeEmail.trim() || null,
    reference: receipt.reference,
    soldOnIso,
    soldOnLabel: receiptSoldOnLabel(soldOnIso),
    customer,
    lines: receipt.lines.map((line) => mergeLine(line, hints)),
    subtotalCents: receipt.subtotalCents,
    subtotalLabel: formatUsd(receipt.subtotalCents),
    saleDiscountCents: receipt.saleDiscountCents,
    saleDiscountLabel: receipt.saleDiscountCents ? `-${formatUsd(receipt.saleDiscountCents)}` : "",
    taxCents: receipt.taxCents,
    taxRateBps: receipt.taxRateBps,
    taxRateLabel: formatTaxRateBps(receipt.taxRateBps),
    taxLineLabel: taxLineLabel(receipt.taxRateBps),
    taxAmountLabel: formatUsd(receipt.taxCents),
    totalCents: receipt.totalCents,
    totalLabel: formatUsd(receipt.totalCents),
    paymentMethod: paymentLabel(receipt),
    channel: channelLabel(receipt.channel, config),
    returnPolicy: config.returnPolicy,
  };
}
