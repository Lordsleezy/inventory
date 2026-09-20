import { printBytes, type PosSettings } from "./local";
import { receiptPrintJob, type ReceiptPayload } from "./receipt";

export async function printReceipt(payload: ReceiptPayload, settings: PosSettings) {
  const job = receiptPrintJob(
    {
      ...payload,
      legal: payload.legal ?? settings.receiptLegal,
      reviewUrl: payload.reviewUrl ?? (settings.reviewUrl || null),
    },
    settings.paperKind,
    settings.charsPerLine,
  );
  return printBytes(job.data, settings.printerPath, job.raw);
}
