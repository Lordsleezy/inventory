import { useCallback, useEffect, useState } from "react";
import { addPhoto, listPhotos, removePhoto } from "@floor/store";
import { useDb } from "../store";
import { capturePhoto, deletePhotoFile, photoSrc } from "../photos";
import { Label, Notice } from "./ui";

type Shown = { id: number; path: string; src: string; isPrimary: boolean };

export function Photos({ sku, disabled }: { sku: string; disabled?: boolean }) {
  const db = useDb();
  const [shown, setShown] = useState<Shown[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const rows = await listPhotos(db, sku);
    const out: Shown[] = [];
    for (const row of rows) {
      try {
        out.push({
          id: row.id,
          path: row.path,
          src: await photoSrc(row.path),
          isPrimary: Number(row.is_primary) === 1,
        });
      } catch {
        // The row survives a missing file so a restore can flag what is gone.
        out.push({ id: row.id, path: row.path, src: "", isPrimary: false });
      }
    }
    setShown(out);
  }, [db, sku]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function add(source: "camera" | "library") {
    setError("");
    setBusy(source === "camera" ? "Opening camera" : "Opening library");
    try {
      const path = await capturePhoto(sku, source);
      await addPhoto(db, sku, path);
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A cancelled picker is not worth an error message.
      if (!/cancel/i.test(message)) setError(message);
    } finally {
      setBusy("");
    }
  }

  async function drop(photo: Shown) {
    setError("");
    try {
      await removePhoto(db, photo.id);
      await deletePhotoFile(photo.path);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="border-b border-floor-line py-3">
      <Label>Photos</Label>

      {shown.length > 0 ? (
        <ul className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {shown.map((photo) => (
            <li key={photo.id} className="relative shrink-0">
              {photo.src ? (
                <img
                  src={photo.src}
                  alt=""
                  className="h-28 w-28 rounded-sm object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="flex h-28 w-28 items-center justify-center rounded-sm border border-floor-line text-center text-quiet text-floor-danger">
                  file missing
                </span>
              )}
              {!disabled ? (
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => void drop(photo)}
                  className="absolute right-1 top-1 h-7 w-7 rounded-full bg-black/70 text-body text-floor-text"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-quiet text-floor-mute">No photos yet.</p>
      )}

      {!disabled ? (
        <div className="mt-2 flex items-center gap-4">
          <button type="button" className="btn-text px-0" disabled={!!busy} onClick={() => void add("camera")}>
            Camera
          </button>
          <button type="button" className="btn-text px-0" disabled={!!busy} onClick={() => void add("library")}>
            Camera roll
          </button>
          {busy ? <span className="text-quiet text-floor-mute">{busy}…</span> : null}
        </div>
      ) : null}

      <Notice tone="error">{error}</Notice>
    </div>
  );
}
