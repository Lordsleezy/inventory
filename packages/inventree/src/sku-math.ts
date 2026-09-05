import { isSku, padSku } from "@floor/domain";

export function nextSkuFromSerials(serials: Array<string | null | undefined>, skuStart: number): string {
  let max = skuStart - 1;
  for (const serial of serials) {
    if (!serial || !isSku(serial)) continue;
    const n = Number(serial);
    if (n > max) max = n;
  }
  const next = max + 1;
  if (next > 99999) throw new Error("SKU space exhausted (99999)");
  return padSku(next);
}
