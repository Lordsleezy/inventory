/** Website cards/detail use these keys. Originals stay in photos.path for listings. */

export const WEB_THUMB_PX = 400;
export const WEB_DETAIL_PX = 1200;
export const WEB_CACHE_CONTROL = "31536000";

export function isWebDerivativePath(path: string): boolean {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 5 && parts[2] === "web" && (parts[3] === "400" || parts[3] === "1200");
}

export function webDerivativePath(originalPath: string, size: 400 | 1200): string {
  if (isWebDerivativePath(originalPath)) return originalPath;
  const parts = originalPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 3 || parts[1] === "archive") {
    throw new Error("Web photo keys are {store_id}/{sku}/web/{size}/{stem}.webp");
  }
  const file = parts[parts.length - 1] ?? "photo.jpg";
  const stem = file.replace(/\.[^.]+$/, "") || "photo";
  return `${parts[0]}/${parts[1]}/web/${size}/${stem}.webp`;
}

export function webDerivativePaths(originalPath: string): string[] {
  return [webDerivativePath(originalPath, 400), webDerivativePath(originalPath, 1200)];
}
