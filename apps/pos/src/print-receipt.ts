import {
  printBytes,
  receiptPdfBytes,
  saveReceiptPdf,
  type PosSettings,
  type PrintResult,
} from "./local";
import {
  charsPerLine,
  receiptPrintJob,
  receiptText,
  type ReceiptBranding,
  type ReceiptPayload,
} from "./receipt";

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
    const pdf = await receiptPdfBytes(text + "\n", resolved.reviewUrl ?? null);
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
  return saveReceiptPdf(text, path, resolved.reviewUrl ?? null);
}
