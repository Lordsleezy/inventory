import { WEB_CACHE_CONTROL, WEB_DETAIL_PX, WEB_THUMB_PX, webDerivativePath, webDerivativePaths } from "@floor/cloud";

async function rasterToWebp(jpeg: Uint8Array, maxEdge: number): Promise<Uint8Array> {
  const blob = new Blob([jpeg], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No canvas");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.72));
    if (!out) throw new Error("WebP resize failed");
    return new Uint8Array(await out.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

export async function uploadWebDerivatives(
  upload: (path: string, bytes: Uint8Array, contentType: string) => Promise<void>,
  originalPath: string,
  jpeg: Uint8Array,
): Promise<void> {
  const thumb = await rasterToWebp(jpeg, WEB_THUMB_PX);
  const detail = await rasterToWebp(jpeg, WEB_DETAIL_PX);
  await upload(webDerivativePath(originalPath, 400), thumb, "image/webp");
  await upload(webDerivativePath(originalPath, 1200), detail, "image/webp");
}

export { WEB_CACHE_CONTROL, webDerivativePaths };
