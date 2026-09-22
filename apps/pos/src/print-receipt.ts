import { printBytes, saveReceiptPdf, type PosSettings, type PrintResult } from "./local";
import {
  charsPerLine,
  receiptPrintJob,
  receiptText,
  type ReceiptBranding,
  type ReceiptPayload,
} from "./receipt";

export async function printReceipt(
  payload: ReceiptPayload,
  settings: PosSettings,
  branding?: ReceiptBranding | null,
): Promise<PrintResult> {
  const job = receiptPrintJob(
    {
      ...payload,
      legal: payload.legal ?? settings.receiptLegal,
      reviewUrl: payload.reviewUrl ?? (settings.reviewUrl || null),
      branding: branding ?? payload.branding,
    },
    settings.paperKind,
    settings.charsPerLine,
    branding,
  );
  return printBytes(job.data, settings.printerPath, job.raw);
}

/** Save receipt as a simple PDF (or .txt path) when no printer is available. */
export async function saveReceiptFile(
  payload: ReceiptPayload,
  settings: PosSettings,
  branding?: ReceiptBranding | null,
  path?: string | null,
) {
  const width = charsPerLine(settings.paperKind === "letter" ? "letter" : settings.paperKind, settings.charsPerLine);
  const text = receiptText(
    {
      ...payload,
      legal: payload.legal ?? settings.receiptLegal,
      reviewUrl: payload.reviewUrl ?? (settings.reviewUrl || null),
    },
    width,
    branding,
  );
  return saveReceiptPdf(text, path);
}
