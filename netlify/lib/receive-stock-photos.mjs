import { marketplaceId, parseCatalogItem, spapiFetch } from "./amazon.mjs";
import { chooseCatalogStockPhotos } from "./stock-photo-match.mjs";
import { searchProductImages } from "./visual-product-search.mjs";

async function catalogItem(storeId, asin) {
  const json = await spapiFetch(storeId, "GET",
    `/catalog/2022-04-01/items/${encodeURIComponent(asin)}?marketplaceIds=${marketplaceId()}&includedData=summaries,images`);
  return parseCatalogItem(json);
}

/** Find catalog images when the barcode itself has none. A slow search returns nothing
 * so Receive can still save the unit photo. */
export async function catalogStockPhotos(storeId, { brand, title, color = "" } = {}, deps = {}) {
  const query = [brand, title].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 150);
  if (query.length < 8) return [];
  const search = deps.search || searchProductImages;
  const load = deps.catalog || ((asin) => catalogItem(storeId, asin));
  let hits = [];
  try { hits = await search(query); } catch { hits = []; }
  const asins = [];
  for (const hit of hits) {
    const asin = String(hit?.url || "").match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase();
    if (asin && !asins.includes(asin)) asins.push(asin);
  }
  const catalogs = [];
  for (const asin of asins.slice(0, 2)) {
    try {
      const item = await load(asin);
      if (item) catalogs.push(item);
    } catch { /* the next product page may still be this item */ }
  }
  return chooseCatalogStockPhotos({ brand, title, color, hits, catalogs });
}

export function stockPhotoSearchTimed(work, ms = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish({ images: [], timedOut: true }), ms);
    Promise.resolve(work).then(
      (images) => finish({ images: images || [], timedOut: false }),
      () => finish({ images: [], timedOut: false }),
    );
  });
}
