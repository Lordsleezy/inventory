import {
  printBytes,
  receiptPdfBytes,
  saveReceiptPdf,
  type PosSettings,
  type PrintResult,
} from "./local";
import { loadStoreSetting } from "@floor/cloud";
import {
  charsPerLine,
  receiptPrintJob,
  receiptText,
  type ReceiptBranding,
  type ReceiptPayload,
} from "./receipt";

/** Store-wide receipt branding saved by the receipt designer. */
export async function loadReceiptBranding(): Promise<ReceiptBranding | null> {
  const raw = await loadStoreSetting("receipt_branding");
  if (!raw) return null;
  return typeof raw === "string" ? (JSON.parse(raw) as ReceiptBranding) : (raw as ReceiptBranding);
}

function resolvePayload(
  payload: ReceiptPayload,
  settings: PosSettings,
  branding?: ReceiptBranding | null,
): ReceiptPayload {
  return {
    ...payload,
    legal: payload.legal ?? settings.receiptLegal,
    reviewUrl: payload.reviewUrl ?? (settings.reviewUrl || null),
    branding: branding ?? payload.branding,
  };
}

export async function printReceipt(
  payload: ReceiptPayload,
  settings: PosSettings,
  branding?: ReceiptBranding | null,
): Promise<PrintResult> {
  const resolved = resolvePayload(payload, settings, branding);
  if (settings.paperKind === "letter") {
    // Full-page receipt goes to CUPS as a PDF so the review QR prints as a
    // real barcode on raster printers (e.g. the Rongta F11).
    const width = charsPerLine("letter", settings.charsPerLine);
    const text = receiptText(resolved, width, branding);
    const review = resolved.reviewUrl || branding?.reviewUrl || resolved.branding?.reviewUrl || null;
    const pdf = await receiptPdfBytes(text + "\n", review);
    return printBytes(pdf, settings.printerPath, false);
  }
  const job = receiptPrintJob(resolved, settings.paperKind, settings.charsPerLine, branding);
  return printBytes(job.data, settings.printerPath, job.raw);
}

/** Save receipt as a simple PDF (or .txt path) when no printer is available. */
export async function saveReceiptFile(
  payload: ReceiptPayload,
  settings: PosSettings,
  branding?: ReceiptBranding | null,
  path?: string | null,
) {
  const resolved = resolvePayload(payload, settings, branding);
  const width = charsPerLine(
    settings.paperKind === "letter" ? "letter" : settings.paperKind,
    settings.charsPerLine,
  );
  const text = receiptText(resolved, width, branding);
  const review = resolved.reviewUrl || branding?.reviewUrl || resolved.branding?.reviewUrl || null;
  return saveReceiptPdf(text, path, review);
}
