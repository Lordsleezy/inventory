import { floorCloud, webDerivativePath } from "@floor/cloud";

const cache = new Map<string, string | null>();

/** Resolve a cart thumb URL for a SKU (signed storage URL). */
export async function unitThumbUrl(sku: string): Promise<string | null> {
  if (cache.has(sku)) return cache.get(sku) ?? null;
  try {
    const sb = floorCloud();
    const { data } = await sb
      .from("photos")
      .select("path, is_primary")
      .eq("sku", sku)
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle();
    const path = data?.path ? String(data.path) : "";
    if (!path) {
      cache.set(sku, null);
      return null;
    }
    let signed = await sb.storage.from("unit-photos").createSignedUrl(webDerivativePath(path, 400), 3600);
    if (!signed.data?.signedUrl) {
      signed = await sb.storage.from("unit-photos").createSignedUrl(path, 3600);
    }
    const url = signed.data?.signedUrl ?? null;
    cache.set(sku, url);
    return url;
  } catch {
    cache.set(sku, null);
    return null;
  }
}
