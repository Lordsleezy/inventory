const PHOTO_EXT = "(jpe?g|png|webp|gif|heic|heif)";

export function parsePhotoFilename(name: string): { sku: string } | null {
  const base = (name.split(/[/\\]/).pop() ?? name).trim();
  const match = base.match(new RegExp(`^(\\d{5})(?:[-_].+)?\\.${PHOTO_EXT}$`, "i"));
  if (!match) return null;
  return { sku: match[1] };
}

export function stockPhotoFilename(sku: string, originalName: string, now = Date.now()): string | null {
  if (!/^\d{5}$/.test(sku)) return null;
  const base = (originalName.split(/[/\\]/).pop() ?? originalName).trim();
  const match = base.match(new RegExp(`\\.${PHOTO_EXT}$`, "i"));
  if (!match) return null;
  let ext = match[1].toLowerCase();
  if (ext === "jpeg") ext = "jpg";
  return `${sku}-${now}.${ext}`;
}
