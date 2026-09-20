import { formatCents, formatCentsTotal } from "@floor/store";

export const STORE_NAME = "Floor";
export const STORE_ADDRESS = "3121 Penryn Rd, Penryn, CA 95663";
export const STORE_PHONE = "(279) 977-0722";

export const DEFAULT_LEGAL =
  "7-DAY EXCHANGE ONLY. No returns and no refunds. With this receipt, you may exchange the item or take store credit within 7 days of sale. Goods are sold AS-IS, WHERE-IS, with all faults, whether or not noted at sale. Floor is not the manufacturer and does not provide manufacturer warranty service unless a remaining OEM warranty still applies to that serial. Keep this receipt.";

export type PaperKind = "letter" | "roll58" | "roll80";

export function defaultCharsPerLine(kind: PaperKind): number {
  if (kind === "roll58") return 32;
  if (kind === "roll80") return 48;
  return 88;
}

export function charsPerLine(kind: PaperKind, override?: number | null): number {
  if (override && override >= 16 && override <= 120) return Math.floor(override);
  return defaultCharsPerLine(kind);
}

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
  tender: string;
  reviewUrl?: string | null;
  legal?: string | null;
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

export function receiptText(payload: ReceiptPayload, width: number): string {
  const legal = (payload.legal || DEFAULT_LEGAL).trim();
  const lines = [
    STORE_NAME,
    ...wrapLine(STORE_ADDRESS, width),
    STORE_PHONE,
    "-".repeat(Math.min(width, 42)),
    pair("Date", payload.soldAt, width),
    pair("Receipt", payload.receiptNo, width),
    pair("Clerk", payload.clerkName, width),
    "-".repeat(Math.min(width, 42)),
    pair("SKU", payload.sku, width),
    ...wrapLine(payload.title, width),
    payload.condition ? pair("Cond", payload.condition, width) : "",
    pair("Price", formatCents(payload.priceCents) || "$0.00", width),
    pair("Tax", formatCents(payload.taxCents) || "$0.00", width),
    pair("TOTAL", formatCentsTotal(payload.totalCents), width),
    pair("Tender", payload.tender, width),
    payload.provisional ? wrapLine("PROVISIONAL — not a final sale until synced.", width).join("\n") : "",
    "-".repeat(Math.min(width, 42)),
    ...wrapLine(legal, width),
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

export function letterBytes(payload: ReceiptPayload, charsOverride?: number | null): Uint8Array {
  const width = charsPerLine("letter", charsOverride);
  let body = receiptText(payload, width) + "\n";
  if (payload.reviewUrl) body += `\nScan to review: ${payload.reviewUrl}\n`;
  body += "\f";
  return ascii(body);
}

export function escPosBytes(payload: ReceiptPayload, kind: "roll58" | "roll80", charsOverride?: number | null): Uint8Array {
  const width = charsPerLine(kind, charsOverride);
  const chunks: Uint8Array[] = [new Uint8Array([0x1b, 0x40]), ascii(receiptText(payload, width) + "\n")];
  if (payload.reviewUrl) {
    chunks.push(ascii("\nScan to review\n"));
    chunks.push(qrCommands(payload.reviewUrl));
    chunks.push(ascii("\n"));
  }
  chunks.push(new Uint8Array([0x1d, 0x56, 0x41, 0x03]));
  return concat(chunks);
}

export function receiptPrintJob(
  payload: ReceiptPayload,
  kind: PaperKind,
  charsOverride?: number | null,
): { data: Uint8Array; raw: boolean } {
  if (kind === "letter") return { data: letterBytes(payload, charsOverride), raw: false };
  return { data: escPosBytes(payload, kind, charsOverride), raw: true };
}
