import { formatCents, formatCentsTotal } from "@floor/store";

export const STORE_NAME = "Floor";
export const STORE_ADDRESS = "3121 Penryn Rd, Penryn, CA 95663";
export const STORE_PHONE = "(279) 977-0722";

export const DEFAULT_LEGAL =
  "7-DAY EXCHANGE ONLY. No returns and no refunds. With this receipt, you may exchange the item or take store credit within 7 days of sale. Goods are sold AS-IS, WHERE-IS, with all faults, whether or not noted at sale. Floor is not the manufacturer and does not provide manufacturer warranty service unless a remaining OEM warranty still applies to that serial. Keep this receipt.";

export type PaperKind = "letter" | "roll58" | "roll80";

export type ReceiptBranding = {
  storeName?: string | null;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  headerMessage?: string | null;
  footerMessage?: string | null;
  legal?: string | null;
  returnPolicy?: string | null;
  reviewUrl?: string | null;
  showSku?: boolean;
  showCondition?: boolean;
  showClerk?: boolean;
  showDiscount?: boolean;
  showPoints?: boolean;
  showTax?: boolean;
  showTenderDetails?: boolean;
};

export const DEFAULT_BRANDING: Required<
  Pick<
    ReceiptBranding,
    | "storeName"
    | "address"
    | "phone"
    | "legal"
    | "showSku"
    | "showCondition"
    | "showClerk"
    | "showDiscount"
    | "showPoints"
    | "showTax"
    | "showTenderDetails"
  >
> &
  ReceiptBranding = {
  storeName: STORE_NAME,
  address: STORE_ADDRESS,
  phone: STORE_PHONE,
  logoUrl: null,
  headerMessage: null,
  footerMessage: null,
  legal: DEFAULT_LEGAL,
  returnPolicy: null,
  reviewUrl: null,
  showSku: true,
  showCondition: true,
  showClerk: true,
  showDiscount: true,
  showPoints: true,
  showTax: true,
  showTenderDetails: true,
};

export function mergeBranding(partial?: ReceiptBranding | null): ReceiptBranding {
  return { ...DEFAULT_BRANDING, ...(partial || {}) };
}

export function defaultCharsPerLine(kind: PaperKind): number {
  if (kind === "roll58") return 32;
  if (kind === "roll80") return 48;
  return 88;
}

export function charsPerLine(kind: PaperKind, override?: number | null): number {
  if (override && override >= 16 && override <= 120) return Math.floor(override);
  return defaultCharsPerLine(kind);
}

export type ReceiptLine = {
  sku: string;
  title: string;
  condition: string | null;
  priceCents: number;
  taxCents: number;
  listPriceCents?: number | null;
};

export type ReceiptTender = {
  method: string;
  cardBrand?: string | null;
  cardLast4?: string | null;
  cashTenderedCents?: number | null;
  changeCents?: number | null;
};

export type ReceiptPayload = {
  receiptNo: string;
  provisional?: boolean;
  soldAt: string;
  clerkName: string;
  sku: string;
  title: string;
  condition: string | null;
  priceCents: number;
  taxCents: number;
  totalCents: number;
  /** Legacy single-line tender label; preferred: tenderDetails */
  tender: string;
  tenderDetails?: ReceiptTender | null;
  discountCents?: number | null;
  pointsEarned?: number | null;
  pointsRedeemed?: number | null;
  pointsBalance?: number | null;
  reviewUrl?: string | null;
  legal?: string | null;
  branding?: ReceiptBranding | null;
  lines?: ReceiptLine[];
};

export function wrapLine(text: string, width: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!word) continue;
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function pair(label: string, value: string, width: number): string {
  const gap = 1;
  const room = Math.max(4, width - label.length - gap);
  const trimmed = value.length > room ? value.slice(0, room) : value;
  const spaces = Math.max(gap, width - label.length - trimmed.length);
  return `${label}${" ".repeat(spaces)}${trimmed}`;
}

function formatTender(payload: ReceiptPayload, branding: ReceiptBranding): string {
  if (!branding.showTenderDetails) return payload.tender;
  const t = payload.tenderDetails;
  if (!t) return payload.tender;
  const bits: string[] = [(t.method || "CASH").toUpperCase()];
  if (t.cardBrand || t.cardLast4) {
    bits.push([t.cardBrand, t.cardLast4 ? `•••• ${t.cardLast4}` : null].filter(Boolean).join(" "));
  }
  if (t.cashTenderedCents != null) bits.push(`tendered ${formatCentsTotal(t.cashTenderedCents)}`);
  if (t.changeCents != null) bits.push(`change ${formatCentsTotal(t.changeCents)}`);
  return bits.filter(Boolean).join(" · ");
}

export function receiptText(payload: ReceiptPayload, width: number, brandingInput?: ReceiptBranding | null): string {
  const branding = mergeBranding({
    ...payload.branding,
    ...brandingInput,
  });
  if (payload.legal) branding.legal = payload.legal;
  if (payload.reviewUrl) branding.reviewUrl = payload.reviewUrl;
  const legal = (branding.legal || DEFAULT_LEGAL).trim();
  const storeName = (branding.storeName || STORE_NAME).trim() || STORE_NAME;
  const address = (branding.address || STORE_ADDRESS).trim();
  const phone = (branding.phone || STORE_PHONE).trim();

  const itemLines =
    payload.lines && payload.lines.length
      ? payload.lines.flatMap((l) => {
          const out: string[] = [];
          if (branding.showSku !== false) out.push(pair("SKU", l.sku, width));
          out.push(...wrapLine(l.title, width));
          if (branding.showCondition !== false && l.condition) out.push(pair("Cond", l.condition, width));
          if (
            branding.showDiscount !== false &&
            l.listPriceCents != null &&
            l.listPriceCents > l.priceCents
          ) {
            out.push(pair("List", formatCents(l.listPriceCents) || "$0.00", width));
          }
          out.push(pair("Price", formatCents(l.priceCents) || "$0.00", width));
          return out;
        })
      : [
          branding.showSku !== false ? pair("SKU", payload.sku, width) : "",
          ...wrapLine(payload.title, width),
          branding.showCondition !== false && payload.condition ? pair("Cond", payload.condition, width) : "",
          pair("Price", formatCents(payload.priceCents) || "$0.00", width),
        ];

  const discount =
    payload.discountCents != null && payload.discountCents > 0
      ? payload.discountCents
      : payload.lines?.reduce((sum, l) => {
          if (l.listPriceCents != null && l.listPriceCents > l.priceCents) {
            return sum + (l.listPriceCents - l.priceCents);
          }
          return sum;
        }, 0) || 0;

  const lines = [
    storeName,
    ...wrapLine(address, width),
    phone,
    branding.headerMessage ? wrapLine(branding.headerMessage, width).join("\n") : "",
    "-".repeat(Math.min(width, 42)),
    pair("Date", payload.soldAt, width),
    pair("Receipt", payload.receiptNo, width),
    branding.showClerk !== false ? pair("Clerk", payload.clerkName, width) : "",
    "-".repeat(Math.min(width, 42)),
    ...itemLines,
    branding.showDiscount !== false && discount > 0
      ? pair("Discount", `-${formatCents(discount) || "$0.00"}`, width)
      : "",
    branding.showTax !== false ? pair("Tax", formatCents(payload.taxCents) || "$0.00", width) : "",
    pair("TOTAL", formatCentsTotal(payload.totalCents), width),
    pair("Tender", formatTender(payload, branding), width),
    branding.showPoints !== false && payload.pointsEarned != null
      ? pair("Pts earned", String(payload.pointsEarned), width)
      : "",
    branding.showPoints !== false && payload.pointsRedeemed != null
      ? pair("Pts used", String(payload.pointsRedeemed), width)
      : "",
    branding.showPoints !== false && payload.pointsBalance != null
      ? pair("Pts bal", String(payload.pointsBalance), width)
      : "",
    payload.provisional ? wrapLine("PROVISIONAL — not a final sale until synced.", width).join("\n") : "",
    "-".repeat(Math.min(width, 42)),
    ...wrapLine(legal, width),
    branding.returnPolicy ? wrapLine(branding.returnPolicy, width).join("\n") : "",
    branding.footerMessage ? wrapLine(branding.footerMessage, width).join("\n") : "",
  ].filter((line) => line !== "");
  return lines.join("\n");
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function qrCommands(url: string): Uint8Array {
  const data = new TextEncoder().encode(url);
  const p = data.length + 3;
  return concat([
    new Uint8Array([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
    new Uint8Array([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06]),
    new Uint8Array([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),
    new Uint8Array([0x1d, 0x28, 0x6b, p & 0xff, (p >> 8) & 0xff, 0x31, 0x50, 0x30]),
    data,
    new Uint8Array([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
  ]);
}

export function letterBytes(
  payload: ReceiptPayload,
  charsOverride?: number | null,
  branding?: ReceiptBranding | null,
): Uint8Array {
  const width = charsPerLine("letter", charsOverride);
  let body = receiptText(payload, width, branding) + "\n";
  const review = payload.reviewUrl || branding?.reviewUrl || payload.branding?.reviewUrl;
  if (review) body += `\nScan to review: ${review}\n`;
  body += "\f";
  return ascii(body);
}

export function escPosBytes(
  payload: ReceiptPayload,
  kind: "roll58" | "roll80",
  charsOverride?: number | null,
  branding?: ReceiptBranding | null,
): Uint8Array {
  const width = charsPerLine(kind, charsOverride);
  const chunks: Uint8Array[] = [new Uint8Array([0x1b, 0x40]), ascii(receiptText(payload, width, branding) + "\n")];
  const review = payload.reviewUrl || branding?.reviewUrl || payload.branding?.reviewUrl;
  if (review) {
    chunks.push(ascii("\nScan to review\n"));
    chunks.push(qrCommands(review));
    chunks.push(ascii("\n"));
  }
  chunks.push(new Uint8Array([0x1d, 0x56, 0x41, 0x03]));
  return concat(chunks);
}

export function receiptPrintJob(
  payload: ReceiptPayload,
  kind: PaperKind,
  charsOverride?: number | null,
  branding?: ReceiptBranding | null,
): { data: Uint8Array; raw: boolean } {
  if (kind === "letter") return { data: letterBytes(payload, charsOverride, branding), raw: false };
  return { data: escPosBytes(payload, kind, charsOverride, branding), raw: true };
}

export function receiptHtmlEmail(payload: ReceiptPayload, brandingInput?: ReceiptBranding | null): string {
  const branding = mergeBranding({ ...mergeBranding(payload.branding), ...(brandingInput || {}) });
  const escape = (t: string) =>
    t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const storeName = escape(branding.storeName || STORE_NAME);
  const lines =
    payload.lines && payload.lines.length
      ? payload.lines
      : [
          {
            sku: payload.sku,
            title: payload.title,
            condition: payload.condition,
            priceCents: payload.priceCents,
            taxCents: payload.taxCents,
          },
        ];
  const itemRows = lines
    .map(
      (l) =>
        `<tr><td>${escape(l.title)}${branding.showSku !== false ? `<div style="color:#666;font-size:12px">${escape(l.sku)}</div>` : ""}</td><td style="text-align:right">${escape(formatCents(l.priceCents) || "$0.00")}</td></tr>`,
    )
    .join("");
  const logo = branding.logoUrl
    ? `<img src="${escape(branding.logoUrl)}" alt="" style="max-height:64px;margin-bottom:8px" />`
    : "";
  return `<!doctype html><html><body style="font:14px/1.5 system-ui,sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">
${logo}
<h1 style="margin:0;font-size:22px">${storeName}</h1>
<p style="color:#555;margin:4px 0 16px">${escape(branding.address || "")}<br/>${escape(branding.phone || "")}</p>
${branding.headerMessage ? `<p>${escape(branding.headerMessage)}</p>` : ""}
<p style="color:#666;font-size:12px">Receipt ${escape(payload.receiptNo)} · ${escape(payload.soldAt)}</p>
<table style="width:100%;border-collapse:collapse">${itemRows}</table>
<div style="border-top:1px solid #ccc;margin-top:12px;padding-top:12px">
${branding.showTax !== false ? `<div style="display:flex;justify-content:space-between"><span>Tax</span><span>${escape(formatCents(payload.taxCents) || "$0.00")}</span></div>` : ""}
<div style="display:flex;justify-content:space-between;font-weight:700;font-size:18px"><span>Total</span><span>${escape(formatCentsTotal(payload.totalCents))}</span></div>
<div style="display:flex;justify-content:space-between"><span>Tender</span><span>${escape(formatTender(payload, branding))}</span></div>
</div>
<p style="color:#555;font-size:12px;margin-top:20px">${escape((branding.legal || DEFAULT_LEGAL).trim())}</p>
${branding.footerMessage ? `<p style="color:#555">${escape(branding.footerMessage)}</p>` : ""}
</body></html>`;
}
