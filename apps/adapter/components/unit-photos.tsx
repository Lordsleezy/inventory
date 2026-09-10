"use client";

import { useEffect, useRef, useState } from "react";
import type { Unit } from "@floor/domain";

type Photo = { pk: number; filename: string };

export function UnitPhotos({
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
    fetch(`/api/units/${sku}/photos`)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Could not load photos");
          return;
        }
        setError("");
        setPhotos(data.photos ?? []);
        if (data.unit) onUnit(data.unit);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load photos");
      });
    return () => {
      cancelled = true;
    };
  }, [sku]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    for (const file of Array.from(files)) form.append("photos", file);
    const res = await fetch(`/api/units/${sku}/photos`, { method: "POST", body: form });
    const data = await res.json();
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    if (!res.ok) {
      setError(data.error ?? "Upload failed");
      return;
    }
    setPhotos(data.photos ?? []);
    if (data.unit) onUnit(data.unit);
  }

  async function setPrimary(attachmentId: number) {
    setBusy(true);
    const res = await fetch(`/api/units/${sku}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachmentId }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not set primary");
      return;
    }
    setPhotos(data.photos ?? []);
    if (data.unit) onUnit(data.unit);
  }

  async function move(index: number, dir: -1 | 1) {
    const next = index + dir;
    if (next < 0 || next >= photos.length) return;
    const order = photos.map((row) => row.pk);
    const [item] = order.splice(index, 1);
    order.splice(next, 0, item);
    setBusy(true);
    const res = await fetch(`/api/units/${sku}/photos`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not reorder");
      return;
    }
    setPhotos(data.photos ?? []);
    if (data.unit) onUnit(data.unit);
    setOpen(next);
  }

  async function remove(attachmentId: number) {
    if (!window.confirm("Delete this photo?")) return;
    setBusy(true);
    const res = await fetch(`/api/units/${sku}/photos`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachmentId }),
    });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(data.error ?? "Could not delete");
      return;
    }
    setPhotos(data.photos ?? []);
    if (data.unit) onUnit(data.unit);
    setOpen(null);
  }

  const current = open != null ? photos[open] : null;

  return (
    <section className="mt-5">
      <div className="mb-2 flex items-center gap-3">
        <p className="text-quiet text-floor-mute">Photos</p>
        <label className="btn-text cursor-pointer px-0">
          Add
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            onChange={(e) => void upload(e.target.files)}
          />
        </label>
        {busy ? <span className="text-quiet text-floor-mute">Working…</span> : null}
      </div>
      {error ? <p className="mb-2 text-body text-floor-danger">{error}</p> : null}
      {photos.length === 0 ? (
        <p className="text-quiet text-floor-mute">
          {loaded ? "No photos yet." : "Loading photos…"}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {photos.map((photo, index) => {
            const primary = unit.primaryAttachmentId === photo.pk;
            return (
              <li key={photo.pk} className="thumb relative">
                <button
                  type="button"
                  onClick={() => setOpen(index)}
                  className={`block size-24 overflow-hidden ${
                    primary ? "ring-1 ring-floor-accent" : ""
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/units/${sku}/photos/${photo.pk}`}
                    alt={photo.filename}
                    className="size-full object-cover"
                  />
                </button>
                <a
                  href={`/api/units/${sku}/photos/${photo.pk}?download=1`}
                  download
                  className="thumb-dl absolute right-1 top-1 inline-flex size-8 items-center justify-center text-white"
                  aria-label={`Download ${photo.filename}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  ↓
                </a>
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
          <button
            type="button"
            className="btn-text self-end text-floor-text"
            onClick={() => setOpen(null)}
          >
            Close
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/units/${sku}/photos/${current.pk}`}
            alt={current.filename}
            className="mx-auto max-h-[70vh] max-w-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <div className="mt-4 flex flex-wrap justify-center gap-2" onClick={(e) => e.stopPropagation()}>
            {unit.primaryAttachmentId === current.pk ? (
              <span className="inline-flex min-h-touch items-center px-2 text-quiet text-floor-accent">
                Primary
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void setPrimary(current.pk)}
                className="btn-text"
              >
                Set primary
              </button>
            )}
            <button
              type="button"
              disabled={busy || open === 0}
              onClick={() => open != null && void move(open, -1)}
              className="btn-text disabled:opacity-40"
            >
              Earlier
            </button>
            <button
              type="button"
              disabled={busy || open === photos.length - 1}
              onClick={() => open != null && void move(open, 1)}
              className="btn-text disabled:opacity-40"
            >
              Later
            </button>
            <a
              href={`/api/units/${sku}/photos/${current.pk}?download=1`}
              download
              className="btn-text"
            >
              Download
            </a>
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
