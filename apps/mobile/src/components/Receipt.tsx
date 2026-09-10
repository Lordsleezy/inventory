import type { SaleReceiptFile } from "@floor/domain";
import { useEffect, useRef, useState } from "react";
import { apiBlobUrl, apiFetch, apiJson } from "../api";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*";

export function ReceiptUpload({
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
    void apiJson<{ sale?: { receiptFile?: SaleReceiptFile | null } }>(`/api/sales/${saleId}`).then(({ ok, data }) => {
      if (cancelled || !ok) return;
      setCurrent(data.sale?.receiptFile ?? null);
    });
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
    const { ok, data } = await apiJson<{ receiptFile?: SaleReceiptFile | null; error?: string }>(
      `/api/sales/${saleId}/receipt`,
      { method: "POST", body },
    );
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    if (!ok) {
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
    const { ok, data } = await apiJson<{ error?: string }>(`/api/sales/${saleId}/receipt`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(data.error ?? "Could not remove receipt");
      return;
    }
    setCurrent(null);
    onChange?.(null);
  }

  async function openReceipt() {
    try {
      const url = await apiBlobUrl(`/api/sales/${saleId}/receipt`);
      window.open(url, "_blank");
    } catch {
      setError("Could not open receipt");
    }
  }

  async function downloadReceipt() {
    const res = await apiFetch(`/api/sales/${saleId}/receipt?download=1`);
    if (!res.ok) {
      setError("Could not download receipt");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = current?.filename || "receipt";
    a.click();
    URL.revokeObjectURL(url);
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
          <button type="button" className="btn-text px-0" onClick={() => void openReceipt()}>
            Open
          </button>
          <button type="button" className="btn-text px-0" onClick={() => void downloadReceipt()}>
            Download
          </button>
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
