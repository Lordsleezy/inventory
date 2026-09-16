"use client";

import { useEffect, useRef, useState } from "react";
import type { SaleReceiptFile } from "@floor/domain";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*";

export function SaleReceiptUpload({
  saleId,
  file,
  onChange,
}: {
  saleId: number;
  file?: SaleReceiptFile | null;
  onChange?: (file: SaleReceiptFile | null) => void;
}) {
  const [current, setCurrent] = useState<SaleReceiptFile | null>(file ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCurrent(file ?? null);
  }, [file]);

  useEffect(() => {
    if (file !== undefined) return;
    let cancelled = false;
    fetch(`/api/sales/${saleId}`)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) return;
        setCurrent(data.sale?.receiptFile ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [saleId, file]);

  async function upload(files: FileList | null) {
    const picked = files?.[0];
    if (!picked) return;
    setBusy(true);
    setError("");
    const body = new FormData();
    body.set("receipt", picked);
    const res = await fetch(`/api/sales/${saleId}/receipt`, { method: "POST", body });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    if (!res.ok) {
      setError(data.error ?? "Could not upload receipt");
      return;
    }
    const next = data.receiptFile ?? null;
    setCurrent(next);
    onChange?.(next);
  }

  async function remove() {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/sales/${saleId}/receipt`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not remove receipt");
      return;
    }
    setCurrent(null);
    onChange?.(null);
  }

  return (
    <div className="mt-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => void upload(e.target.files)}
      />
      {current ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <p className="text-quiet text-floor-mute">{current.filename}</p>
          <a href={`/api/sales/${saleId}/receipt`} target="_blank" rel="noreferrer" className="btn-text px-0">
            Open
          </a>
          <a href={`/api/sales/${saleId}/receipt?download=1`} className="btn-text px-0">
            Download
          </a>
          <button type="button" disabled={busy} className="btn-text px-0" onClick={() => inputRef.current?.click()}>
            Replace
          </button>
          <button type="button" disabled={busy} className="btn-text px-0" onClick={() => void remove()}>
            Remove
          </button>
        </div>
      ) : (
        <button type="button" disabled={busy} className="btn-text px-0" onClick={() => inputRef.current?.click()}>
          {busy ? "Uploading…" : "Upload receipt"}
        </button>
      )}
      {error ? <p className="mt-1 text-body text-floor-danger">{error}</p> : null}
    </div>
  );
}
