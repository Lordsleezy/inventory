/** Digit length is a setting. Default 5; do not scatter /^\d{5}$/ in callers. */

export const DEFAULT_SKU_DIGITS = 5;

export function skuCeiling(digits: number = DEFAULT_SKU_DIGITS): number {
  return 10 ** digits - 1;
}

export function isSku(value: string, digits: number = DEFAULT_SKU_DIGITS): boolean {
  if (!Number.isInteger(digits) || digits < 1) return false;
  return new RegExp(`^\\d{${digits}}$`).test(value);
}

export function padSku(n: number, digits: number = DEFAULT_SKU_DIGITS): string {
  return String(n).padStart(digits, "0");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function storagePathForPhoto(storeId: string, sku: string, originalPath: string): string {
  if (!UUID_RE.test(storeId)) {
    throw new Error("Photo storage keys are {store_id}/{sku}/{filename}.");
  }
  if (!sku || sku.includes("/")) {
    throw new Error("Photo storage keys are {store_id}/{sku}/{filename}.");
  }
  const base = originalPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "photo.jpg";
  return `${storeId}/${sku}/${base}`;
}
