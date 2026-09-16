"use client";

export function ReceiptLinks({
  saleId,
  printMode = "page",
  tone = "app",
}: {
  saleId: number;
  printMode?: "page" | "window";
  tone?: "app" | "document";
}) {
  const btn = tone === "document" ? "receipt-btn" : "inline-flex min-h-touch items-center px-0 text-body text-floor-mute";
  const primary =
    tone === "document" ? "receipt-btn receipt-btn-primary" : "inline-flex min-h-touch items-center px-0 text-body text-floor-mute";
  return (
    <div className={tone === "document" ? "receipt-actions no-print" : "mt-2 flex flex-wrap gap-x-4 gap-y-1"}>
      {printMode === "window" ? (
        <button type="button" className={btn} onClick={() => window.print()}>
          Print
        </button>
      ) : (
        <a className={btn} href={`/receipt?sale=${saleId}`}>
          Print
        </a>
      )}
      <a className={primary} href={`/api/sales/${saleId}/receipt`}>
        Download PDF
      </a>
    </div>
  );
}
