import sharp from "sharp";
import { WEB_CACHE_CONTROL, webDerivativePath, webDerivativePaths } from "@floor/cloud";

export async function makeWebBytes(input, size) {
  return sharp(input)
    .rotate()
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 72, effort: 4 })
    .toBuffer();
}

export async function syncWebDerivatives(client, originalPath, jpegBytes) {
  for (const size of [400, 1200]) {
    const key = webDerivativePath(originalPath, size);
    const body = await makeWebBytes(jpegBytes, size);
    const up = await client.storage.from("unit-photos").upload(key, body, {
      upsert: true,
      contentType: "image/webp",
      cacheControl: WEB_CACHE_CONTROL,
    });
    if (up.error) throw new Error(`web ${size}: ${up.error.message}`);
  }
}

export async function removeWebDerivatives(client, originalPath) {
  const keys = webDerivativePaths(originalPath);
  const { error } = await client.storage.from("unit-photos").remove(keys);
  if (error) throw new Error(error.message);
}
