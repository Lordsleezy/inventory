import type { Cents } from "./money.ts";
import type { SaleReceiptFile } from "./receipt-file.ts";
import type { Unit } from "./unit.ts";

export type SaleStatus = "open" | "parked" | "completed" | "cancelled";
export type RestockState = "available" | "repair" | "scrapped";

export type SaleCustomer = {
  name: string | null;
  phone: string | null;
  email: string | null;
};

export type SalePayment = {
  method: string;
  cents: Cents;
  at: string;
};

export type SaleLine = {
  sku: string;
  stockId: number;
  lineId: number;
  title: string;
  brand: string;
  model: string;
  description: string;
  condition: string | null;
  askCents: Cents | null;
  floorCents: Cents | null;
  priceCents: Cents;
};

export type SaleReceiptLine = {
  sku: string;
  title: string;
  brand?: string;
  model?: string;
  description?: string;
  condition?: string | null;
  priceCents: Cents;
  channel: string;
};

export type SaleReceipt = {
  saleId: number;
  reference: string;
  soldOn: string;
  channel: string;
  customer: SaleCustomer;
  lines: SaleReceiptLine[];
  saleDiscountCents: Cents;
  taxRateBps: number;
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  payments: SalePayment[];
};

export type FloorSale = {
  id: number;
  reference: string;
  status: SaleStatus;
  customer: SaleCustomer;
  lines: SaleLine[];
  saleDiscountCents: Cents;
  taxRateBps: number;
  subtotalCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  payments: SalePayment[];
  parkedAt: string | null;
  receipt: SaleReceipt | null;
  receiptFile: SaleReceiptFile | null;
};

export type SaleHistoryRow = {
  id: number;
  reference: string;
  soldOn: string;
  channel: string;
  customerName: string | null;
  customerPhone: string | null;
  skus: string[];
  lineSummary: string;
  totalCents: Cents;
  receiptFile: SaleReceiptFile | null;
};

export function snapshotReceiptLine(
  line: Pick<SaleLine, "sku" | "title" | "brand" | "model" | "description" | "condition" | "priceCents">,
  channel: string,
): SaleReceiptLine {
  return {
    sku: line.sku,
    title: line.title,
    brand: line.brand,
    model: line.model,
    description: line.description,
    condition: line.condition,
    priceCents: line.priceCents,
    channel,
  };
}

export function saleHistoryFromReceipt(
  receipt: SaleReceipt,
  receiptFile: SaleReceiptFile | null = null,
): SaleHistoryRow {
  return {
    id: receipt.saleId,
    reference: receipt.reference,
    soldOn: receipt.soldOn,
    channel: receipt.channel,
    customerName: receipt.customer.name,
    customerPhone: receipt.customer.phone,
    skus: receipt.lines.map((line) => line.sku),
    lineSummary: receipt.lines.map((line) => `${line.sku} ${line.title}`.trim()).join(", "),
    totalCents: receipt.totalCents,
    receiptFile,
  };
}

export function receiptFromSale(sale: FloorSale): SaleReceipt {
  if (sale.receipt) return sale.receipt;
  const soldOn = sale.payments[0]?.at ?? sale.parkedAt ?? "";
  const totals = saleTotals({
    linePriceCents: sale.lines.map((line) => line.priceCents),
    saleDiscountCents: sale.saleDiscountCents,
    taxRateBps: sale.taxRateBps,
  });
  return {
    saleId: sale.id,
    reference: sale.reference,
    soldOn,
    channel: "floor",
    customer: sale.customer,
    lines: sale.lines.map((line) => snapshotReceiptLine(line, "floor")),
    saleDiscountCents: sale.saleDiscountCents,
    taxRateBps: sale.taxRateBps,
    subtotalCents: totals.subtotalCents,
    taxCents: totals.taxCents,
    totalCents: totals.totalCents,
    payments: sale.payments,
  };
}

export function filterSaleHistory(rows: SaleHistoryRow[], query: string): SaleHistoryRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const digits = q.replace(/\D/g, "");
  return rows.filter((row) => {
    if (row.skus.some((sku) => sku.includes(q) || (digits && sku.includes(digits)))) return true;
    if ((row.customerName ?? "").toLowerCase().includes(q)) return true;
    if (digits.length >= 3 && (row.customerPhone ?? "").replace(/\D/g, "").includes(digits)) return true;
    if (row.soldOn.toLowerCase().includes(q)) return true;
    if (row.reference.toLowerCase().includes(q)) return true;
    if (row.lineSummary.toLowerCase().includes(q)) return true;
    if (row.channel.toLowerCase().includes(q)) return true;
    return false;
  });
}

export function saleTotals(input: {
  linePriceCents: Cents[];
  saleDiscountCents: Cents;
  taxRateBps: number;
}): { subtotalCents: Cents; taxCents: Cents; totalCents: Cents } {
  const lines = input.linePriceCents.reduce((sum, cents) => sum + cents, 0);
  const discount = Math.max(0, input.saleDiscountCents);
  const subtotalCents = Math.max(0, lines - discount);
  const taxCents = Math.round((subtotalCents * input.taxRateBps) / 10000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

export function belowFloorError(
  priceCents: Cents,
  floorCents: Cents | null,
  role: "admin" | "staff",
  confirmed: boolean,
): { status: number; message: string } | null {
  if (floorCents === null || priceCents >= floorCents) return null;
  if (role === "staff") return { status: 403, message: "Price is below floor" };
  if (!confirmed) return { status: 409, message: "Price is below floor — confirm to continue" };
  return null;
}

export function cannotSellReason(unit: Unit): string | null {
  if (unit.recordError) return "This item has a record error and cannot be sold";
  if (unit.state === "sold") return "Already sold";
  if (unit.state === "reserved") return "Already in an open sale";
  if (unit.state === "voided") return "Voided items cannot be sold";
  if (unit.state === "scrapped") return "Scrapped items cannot be sold";
  if (unit.state === "lost") return "Lost items cannot be sold";
  if (unit.state === "repair") return "Items in repair cannot be sold";
  if (unit.state !== "available") return `Cannot sell a ${unit.state} item`;
  return null;
}

export const RESTOCK_STATES: RestockState[] = ["available", "repair", "scrapped"];

export function isRestockState(value: string): value is RestockState {
  return (RESTOCK_STATES as string[]).includes(value);
}

export function isOpenSaleStatus(status: SaleStatus): boolean {
  return status === "open" || status === "parked";
}

export function withSaleTotals(
  sale: Omit<FloorSale, "subtotalCents" | "taxCents" | "totalCents">,
): FloorSale {
  const totals = saleTotals({
    linePriceCents: sale.lines.map((line) => line.priceCents),
    saleDiscountCents: sale.saleDiscountCents,
    taxRateBps: sale.taxRateBps,
  });
  return { ...sale, receipt: sale.receipt ?? null, receiptFile: sale.receiptFile ?? null, ...totals };
}
