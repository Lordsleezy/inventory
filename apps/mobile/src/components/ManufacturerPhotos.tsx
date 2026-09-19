import { useCallback, useEffect, useState } from "react";
import { parseListingSpecs } from "@floor/store";
import { floorCloud } from "@floor/cloud";
import { useStore } from "../store";
import { Label, Notice } from "./ui";
import { PhotoViewer, type ViewerPhoto } from "./PhotoViewer";
import { friendlyRpc } from "../rpc";

type Row = { id: number; path: string; source_url: string; sort_order: number };

function publicUrl(path: string): string {
  const base = String(import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
  if (!base || !path) return "";
  return `${base}/storage/v1/object/public/manufacturer-photos/${path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")}`;
}

export function ManufacturerPhotos({
  sku,
  brand,
  model,
  listingSpecs,
  disabled,
}: {
  sku: string;
  brand: string;
  model: string;
  listingSpecs?: string | null;
  disabled?: boolean;
}) {
  const { online, ensureOnline } = useStore();
  const [shown, setShown] = useState<ViewerPhoto[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const matched = (parseListingSpecs(listingSpecs)?.matched_model || model || "").trim();

  const refresh = useCallback(async () => {
    if (!brand.trim() || !matched) {
      setShown([]);
      return;
    }
    const { data, error: qErr } = await floorCloud()
      .from("manufacturer_photos")
      .select("id, path, source_url, sort_order")
      .ilike("brand", brand.trim())
      .ilike("model", matched)
      .order("sort_order", { ascending: true });
    if (qErr) throw qErr;
    setShown(
      ((data ?? []) as Row[]).map((row) => ({
        id: Number(row.id),
        src: publicUrl(row.path),
        isPrimary: false,
        caption: "Manufacturer photo",
        canSetPrimary: false,
      })),
    );
  }, [brand, matched]);

  useEffect(() => {
    void refresh().catch((err) => setError(friendlyRpc(err)));
  }, [refresh]);

  return (
    <div className="border-b border-floor-line py-3">
      <Label>Manufacturer photos</Label>
      <p className="mt-1 text-quiet text-floor-mute">
          Official catalog shots for {matched || "this model"} (SKU {sku}). Shared by every unit of that model. Remove one if it is the wrong product.
      </p>
      {shown.length > 0 ? (
        <ul className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {shown.map((photo, i) => (
            <li key={photo.id} className="relative shrink-0">
              <button type="button" className="block" onClick={() => setOpen(i)} aria-label="Open manufacturer photo">
                {photo.src ? (
                  <img src={photo.src} alt="" className="h-28 w-28 rounded-sm object-cover" loading="lazy" />
                ) : (
                  <span className="flex h-28 w-28 items-center justify-center rounded-sm border border-floor-line text-center text-quiet text-floor-danger">
                    file missing
                  </span>
                )}
              </button>
              <span className="absolute bottom-1 left-1 bg-black/70 px-1 text-[10px] uppercase tracking-wide text-floor-text">
                Mfr
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-quiet text-floor-mute">
          {matched ? "No manufacturer photos for this model yet." : "No confirmed model match."}
        </p>
      )}
      <Notice tone="error">{error}</Notice>
      {open != null && shown[open] ? (
        <PhotoViewer
          key={shown.map((p) => p.id).join("-")}
          photos={shown}
          start={open}
          canEdit={!disabled && online}
          onClose={() => setOpen(null)}
          onPrimary={async () => undefined}
          onDelete={async (id) => {
            try {
              await ensureOnline();
              const { error: rpcErr } = await floorCloud().rpc("delete_manufacturer_photo", { p_id: id });
              if (rpcErr) throw rpcErr;
              await refresh();
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
