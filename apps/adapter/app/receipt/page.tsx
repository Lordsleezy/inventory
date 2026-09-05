"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { formatUsd, receiptFromSale, type FloorSale } from "@floor/domain";

function ReceiptSheet() {
  const params = useSearchParams();
  const id = params.get("sale");
  const [sale, setSale] = useState<FloorSale | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    fetch(`/api/sales/${id}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? "Receipt not found");
          return;
        }
        setSale(data.sale);
      })
      .catch(() => setError("Receipt not found"));
  }, [id]);

  return (
    <div className="receipt-root bg-white text-black">
      <style>{`
        .receipt-root { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 3.2in; margin: 0 auto; padding: 16px; }
        .receipt-store { font-size: 22px; font-weight: 900; text-align: center; }
        .receipt-ref { font-size: 16px; text-align: center; margin-top: 4px; }
        .receipt-line { display: flex; justify-content: space-between; gap: 8px; font-size: 16px; margin-top: 8px; }
        .receipt-sku { font-weight: 800; letter-spacing: 0.08em; }
        .receipt-total { font-size: 22px; font-weight: 900; margin-top: 12px; border-top: 2px solid #111; padding-top: 8px; }
        @media print {
          body { background: white; }
          .no-print { display: none; }
        }
      `}</style>
      <div className="no-print p-3">
        <button type="button" onClick={() => window.print()} className="min-h-11 rounded bg-black px-4 font-bold text-white">
          Print
        </button>
      </div>
      {error ? <p>{error}</p> : null}
      {sale ? <ReceiptBody sale={sale} /> : null}
    </div>
  );
}

function ReceiptBody({ sale }: { sale: FloorSale }) {
  const receipt = receiptFromSale(sale);
  return (
    <article>
      <div className="receipt-store">FLOOR</div>
      <div className="receipt-ref">{receipt.reference}</div>
      {receipt.soldOn ? <div className="receipt-ref">{receipt.soldOn.slice(0, 10)}</div> : null}
      {receipt.channel ? <div className="receipt-ref">{receipt.channel}</div> : null}
      {receipt.customer.name ? <div className="receipt-ref">{receipt.customer.name}</div> : null}
      {receipt.lines.map((line) => (
        <div key={line.sku} className="receipt-line">
          <div>
            <div className="receipt-sku">{line.sku}</div>
            <div>{line.title}</div>
          </div>
          <div>{formatUsd(line.priceCents)}</div>
        </div>
      ))}
      {receipt.saleDiscountCents ? (
        <div className="receipt-line">
          <div>Discount</div>
          <div>-{formatUsd(receipt.saleDiscountCents)}</div>
        </div>
      ) : null}
      <div className="receipt-line">
        <div>Tax</div>
        <div>{formatUsd(receipt.taxCents) || ""}</div>
      </div>
      <div className="receipt-line receipt-total">
        <div>Total</div>
        <div>{formatUsd(receipt.totalCents)}</div>
      </div>
      {receipt.payments.map((pay, i) => (
        <div key={`${pay.at}-${i}`} className="receipt-line">
          <div>{pay.method}</div>
          <div>{formatUsd(pay.cents)}</div>
        </div>
      ))}
    </article>
  );
}

export default function ReceiptPage() {
  return (
    <Suspense>
      <ReceiptSheet />
    </Suspense>
  );
}
