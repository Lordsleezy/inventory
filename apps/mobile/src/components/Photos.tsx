import { useCallback, useEffect, useState } from "react";
import { listPhotos } from "@floor/store";
import { floorCloud, storagePathForPhoto, webDerivativePaths } from "@floor/cloud";
import { uploadWebDerivatives, WEB_CACHE_CONTROL } from "../web-photo";
import { useStore } from "../store";
import { capturePhoto, deletePhotoFile, photoSrc, readPhotoBase64 } from "../photos";
import { Label, Notice } from "./ui";
import { PhotoViewer } from "./PhotoViewer";
import { friendlyRpc } from "../rpc";

type Shown = { id: number; path: string; src: string; isPrimary: boolean };

function isCloudPath(path: string): boolean {
  return /^[0-9a-f-]{36}\//i.test(path);
}

export function Photos({ sku, disabled }: { sku: string; disabled?: boolean }) {
  const { db, session, online, hydrate, cacheEpoch, ensureOnline } = useStore();
  const [shown, setShown] = useState<Shown[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const rows = await listPhotos(db, sku);
    const out: Shown[] = [];
    for (const row of rows) {
      try {
        let src = "";
        if (isCloudPath(row.path)) {
          const signed = await floorCloud().storage.from("unit-photos").createSignedUrl(row.path, 3600);
          src = signed.data?.signedUrl ?? "";
        } else {
          src = await photoSrc(row.path);
        }
        out.push({
          id: Number(row.id),
          path: row.path,
          src,
          isPrimary: Number(row.is_primary) === 1,
        });
      } catch {
        out.push({ id: Number(row.id), path: row.path, src: "", isPrimary: false });
      }
    }
    setShown(out);
  }, [db, sku]);

  useEffect(() => {
    void refresh();
  }, [refresh, cacheEpoch]);

  async function add(source: "camera" | "library") {
    setError("");
    if (!online) {
      setError("Connect to the internet to add photos.");
      return;
    }
    setBusy(source === "camera" ? "Opening camera" : "Opening library");
    try {
      const local = await capturePhoto(sku, source);
      const b64 = await readPhotoBase64(local);
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const path = storagePathForPhoto(session.storeId, sku, local);
      const up = await floorCloud().storage.from("unit-photos").upload(path, raw, {
        contentType: "image/jpeg",
        upsert: true,
      });
      if (up.error) throw up.error;
      try {
        await uploadWebDerivatives(async (webPath, bytes, contentType) => {
          const webUp = await floorCloud().storage.from("unit-photos").upload(webPath, bytes, {
            contentType,
            upsert: true,
            cacheControl: WEB_CACHE_CONTROL,
          });
          if (webUp.error) throw webUp.error;
        }, path, raw);
      } catch {
        // Shop falls back to the original until a backfill runs.
      }
      const { error: rpcErr } = await floorCloud().rpc("add_unit_photo", { p_sku: sku, p_path: path });
      if (rpcErr) throw rpcErr;
      await hydrate();
      await refresh();
    } catch (err) {
      const message = friendlyRpc(err);
      if (!/cancel/i.test(message)) setError(message);
    } finally {
      setBusy("");
    }
  }

  async function remove(id: number) {
    setError("");
    await ensureOnline();
    const photo = shown.find((p) => p.id === id);
    const { error: rpcErr } = await floorCloud().rpc("delete_unit_photo", { p_id: id });
    if (rpcErr) throw rpcErr;
    if (photo?.path && isCloudPath(photo.path)) {
      await floorCloud().storage.from("unit-photos").remove([photo.path, ...webDerivativePaths(photo.path)]);
    } else if (photo?.path) {
      await deletePhotoFile(photo.path);
    }
    const nextIndex = shown.findIndex((p) => p.id === id);
    await hydrate();
    await refresh();
    const remaining = shown.filter((p) => p.id !== id);
    if (!remaining.length) setOpen(null);
    else setOpen(Math.min(nextIndex, remaining.length - 1));
  }

  async function makePrimary(id: number) {
    setError("");
    await ensureOnline();
    const { error: rpcErr } = await floorCloud().rpc("set_primary_photo", { p_id: id });
    if (rpcErr) throw rpcErr;
    await hydrate();
    await refresh();
  }

  return (
    <div className="border-b border-floor-line py-3">
      <Label>Photos</Label>
      {shown.length > 0 ? (
        <ul className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {shown.map((photo, i) => (
            <li key={photo.id} className="relative shrink-0">
              <button type="button" className="block" onClick={() => setOpen(i)} aria-label="Open photo">
                {photo.src ? (
                  <img src={photo.src} alt="" className="h-28 w-28 rounded-sm object-cover" loading="lazy" />
                ) : (
                  <span className="flex h-28 w-28 items-center justify-center rounded-sm border border-floor-line text-center text-quiet text-floor-danger">
                    file missing
                  </span>
                )}
              </button>
              {photo.isPrimary ? (
                <span className="absolute bottom-1 left-1 bg-black/70 px-1 text-[10px] uppercase tracking-wide text-floor-text">
                  Primary
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-quiet text-floor-mute">No photos yet.</p>
      )}
      {!disabled ? (
        <div className="mt-2 flex items-center gap-4">
          <button type="button" className="btn-text px-0" disabled={!!busy || !online} onClick={() => void add("camera")}>
            Camera
          </button>
          <button type="button" className="btn-text px-0" disabled={!!busy || !online} onClick={() => void add("library")}>
            Camera roll
          </button>
          {busy ? <span className="text-quiet text-floor-mute">{busy}…</span> : null}
        </div>
      ) : null}
      <Notice tone="error">{error}</Notice>
      {open != null && shown[open] ? (
        <PhotoViewer
          key={shown.map((p) => p.id).join("-")}
          photos={shown}
          start={open}
          canEdit={!disabled && online}
          onClose={() => setOpen(null)}
          onDelete={async (id) => {
            try {
              await remove(id);
            } catch (err) {
              const message = friendlyRpc(err);
              setError(message);
              throw new Error(message);
            }
          }}
          onPrimary={async (id) => {
            try {
              await makePrimary(id);
            } catch (err) {
              const message = friendlyRpc(err);
              setError(message);
              throw new Error(message);
            }
          }}
        />
      ) : null}
    </div>
  );
}
