import type { Unit } from "@floor/domain";
import { useEffect, useRef, useState } from "react";
import { apiBlobUrl, apiJson, forgetBlobUrl } from "../api";
import { pickNativePhotos } from "../native-photo";

type Photo = { pk: number; filename: string };

function PhotoImg({ sku, id, alt, className }: { sku: string; id: number; alt: string; className?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let cancelled = false;
    const path = `/api/units/${sku}/photos/${id}`;
    void apiBlobUrl(path)
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sku, id]);
  if (!src) return <div className={`bg-floor-panel ${className ?? ""}`} />;
  return <img src={src} alt={alt} className={className} />;
}

export function Photos({
  sku,
  unit,
  onUnit,
}: {
  sku: string;
  unit: Unit;
  onUnit: (unit: Unit) => void;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void apiJson<{ photos?: Photo[]; unit?: Unit; error?: string }>(`/api/units/${sku}/photos`).then(
      ({ ok, data }) => {
        if (cancelled) return;
        if (!ok) {
          setError(data.error ?? "Could not load photos");
          return;
        }
        setError("");
        setPhotos(data.photos ?? []);
        if (data.unit) onUnit(data.unit);
        setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sku, onUnit]);

  async function upload(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    for (const file of Array.from(files)) form.append("photos", file);
    const { ok, data } = await apiJson<{ photos?: Photo[]; unit?: Unit; error?: string }>(
      `/api/units/${sku}/photos`,
      { method: "POST", body: form },
    );
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    if (!ok) {
      setError(data.error ?? "Upload failed");
      return;
    }
    for (const photo of data.photos ?? []) forgetBlobUrl(`/api/units/${sku}/photos/${photo.pk}`);
    setPhotos(data.photos ?? []);
    if (data.unit) onUnit(data.unit);
  }

  async function setPrimary(attachmentId: number) {
    setBusy(true);
    const { ok, data } = await apiJson<{ photos?: Photo[]; unit?: Unit; error?: string }>(
      `/api/units/${sku}/photos`,
      { method: "POST", body: JSON.stringify({ attachmentId }) },
    );
    setBusy(false);
    if (!ok) {
      setError(data.error ?? "Could not set primary");
      return;
    }
    setPhotos(data.photos ?? []);
    if (data.unit) onUnit(data.unit);
  }

  async function remove(attachmentId: number) {
    if (!window.confirm("Delete this photo?")) return;
    setBusy(true);
    const { ok, data } = await apiJson<{ photos?: Photo[]; unit?: Unit; error?: string }>(
      `/api/units/${sku}/photos`,
      { method: "DELETE", body: JSON.stringify({ attachmentId }) },
    );
    setBusy(false);
    if (!ok) {
      setError(data.error ?? "Could not delete");
      return;
    }
    forgetBlobUrl(`/api/units/${sku}/photos/${attachmentId}`);
    setPhotos(data.photos ?? []);
    if (data.unit) onUnit(data.unit);
    setOpen(null);
  }

  const current = open != null ? photos[open] : null;

  return (
    <section className="mt-5">
      <div className="mb-2 flex items-center gap-3">
        <p className="text-quiet text-floor-mute">Photos</p>
        <button
          type="button"
          className="btn-text px-0"
          onClick={() => {
            void pickNativePhotos().then((files) => {
              if (files) void upload(files);
              else inputRef.current?.click();
            });
          }}
        >
          Library
        </button>
        <label className="btn-text cursor-pointer px-0">
          Camera
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={(e) => void upload(e.target.files)}
          />
        </label>
        {busy ? <span className="text-quiet text-floor-mute">Working…</span> : null}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        onChange={(e) => void upload(e.target.files)}
      />
      {error ? <p className="mb-2 text-body text-floor-danger">{error}</p> : null}
      {photos.length === 0 ? (
        <p className="text-quiet text-floor-mute">{loaded ? "No photos yet." : "Loading photos…"}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {photos.map((photo, index) => {
            const primary = unit.primaryAttachmentId === photo.pk;
            return (
              <li key={photo.pk}>
                <button
                  type="button"
                  onClick={() => setOpen(index)}
                  className={`block size-24 overflow-hidden ${primary ? "ring-1 ring-floor-accent" : ""}`}
                >
                  <PhotoImg sku={sku} id={photo.pk} alt={photo.filename} className="size-full object-cover" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {current ? (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setOpen(null)}
        >
          <button type="button" className="btn-text self-end text-floor-text" onClick={() => setOpen(null)}>
            Close
          </button>
          <PhotoImg
            sku={sku}
            id={current.pk}
            alt={current.filename}
            className="mx-auto max-h-[70vh] max-w-full object-contain"
          />
          <div className="mt-4 flex flex-wrap justify-center gap-2" onClick={(e) => e.stopPropagation()}>
            {unit.primaryAttachmentId === current.pk ? (
              <span className="inline-flex min-h-touch items-center px-2 text-quiet text-floor-accent">Primary</span>
            ) : (
              <button type="button" disabled={busy} onClick={() => void setPrimary(current.pk)} className="btn-text">
                Set primary
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove(current.pk)}
              className="btn-text text-floor-danger"
            >
              Delete
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
