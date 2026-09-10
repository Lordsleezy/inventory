import { formatCents, formatCentsTotal } from "./money.ts";
import type { Sale, Settings, Unit } from "./store.ts";

export type Receipt = {
  receiptNo: string;
  soldAt: string;
  storeName: string;
  channel: string;
  customerName: string | null;
  customerPhone: string | null;
  sku: string;
  description: string;
  condition: string | null;
  priceCents: number;
  taxCents: number;
  totalCents: number;
  voidedAt: string | null;
};

export function buildReceipt(sale: Sale, unit: Unit | null, settings: Settings): Receipt {
  const taxCents = Math.round((sale.priceCents * settings.taxRateBps) / 10000);
  return {
    receiptNo: sale.receiptNo,
    soldAt: sale.soldAt,
    storeName: settings.storeName,
    channel: sale.channel,
    customerName: sale.customerName,
    customerPhone: sale.customerPhone,
    sku: sale.sku,
    description:
      [unit?.brand, unit?.model].filter(Boolean).join(" ") || unit?.title || "Item",
    condition: unit?.condition ?? null,
    priceCents: sale.priceCents,
    taxCents,
    totalCents: sale.priceCents + taxCents,
    voidedAt: sale.voidedAt,
  };
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** Self-contained HTML. Prints via AirPrint and saves via the share sheet. */
export function receiptHtml(receipt: Receipt): string {
  const when = new Date(receipt.soldAt).toLocaleString("en-US");
  const rows: [string, string][] = [
    ["SKU", receipt.sku],
    ["Item", receipt.description],
  ];
  if (receipt.condition) rows.push(["Condition", receipt.condition]);
  rows.push(["Channel", receipt.channel]);
  if (receipt.customerName) rows.push(["Customer", receipt.customerName]);
  if (receipt.customerPhone) rows.push(["Phone", receipt.customerPhone]);

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(receipt.receiptNo)}</title>
<style>
  body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;color:#111}
  .sheet{max-width:420px;margin:0 auto}
  h1{font-size:20px;margin:0}
  .muted{color:#666;font-size:12px}
  table{width:100%;border-collapse:collapse;margin:20px 0}
  th{text-align:left;font-weight:600;padding:6px 0;color:#555;width:38%;vertical-align:top}
  td{padding:6px 0;text-align:right}
  .totals{border-top:1px solid #ccc;padding-top:12px}
  .totals div{display:flex;justify-content:space-between;padding:3px 0}
  .grand{font-size:18px;font-weight:700;border-top:1px solid #ccc;margin-top:8px;padding-top:8px}
  .void{border:2px solid #b00;color:#b00;padding:8px;text-align:center;font-weight:700;margin-bottom:16px}
  @media print{body{padding:0}.noprint{display:none}}
</style></head>
<body><div class="sheet">
${receipt.voidedAt ? `<div class="void">VOIDED ${escape(new Date(receipt.voidedAt).toLocaleString("en-US"))}</div>` : ""}
<h1>${escape(receipt.storeName)}</h1>
<div class="muted">Receipt ${escape(receipt.receiptNo)} &middot; ${escape(when)}</div>
<table>${rows.map(([k, v]) => `<tr><th>${escape(k)}</th><td>${escape(v)}</td></tr>`).join("")}</table>
<div class="totals">
  <div><span>Price</span><span>${formatCents(receipt.priceCents)}</span></div>
  ${receipt.taxCents > 0 ? `<div><span>Tax</span><span>${formatCents(receipt.taxCents)}</span></div>` : ""}
  <div class="grand"><span>Total</span><span>${formatCentsTotal(receipt.totalCents)}</span></div>
</div>
<p class="muted">All sales final unless otherwise agreed in writing.</p>
<p class="noprint"><button onclick="window.print()">Print</button></p>
</div></body></html>`;
}
