/**
 * eBay catalog photos for ikonikdeals2026.
 * A photo is used only when the UPC or exact brand+model matches and a
 * look at both images confirms the same product, color, and pack size.
 */
import {
  aspectText,
  damageText,
  identifiersFrom,
  isCollectible,
  photoDecision,
  pickCatalogProduct,
  withCatalogMainPhoto,
} from "./ebay-listing-standards.mjs";

function catalogText(product) {
  return [product?.title, product?.brand, product?.mpn, aspectText(product?.aspects)].filter(Boolean).join(" ");
}

function ourText(unit, aspects) {
  return [unit?.title, unit?.brand, unit?.model, unit?.ebay_title, aspectText(aspects), aspectText(unit?.ebay_item_specifics)].filter(Boolean).join(" ");
}

async function searchProducts(fetchJson, { gtin, brand, model }) {
  const rows = [];
  if (gtin) {
    const data = await fetchJson(`/commerce/catalog/v1_beta/product_summary/search?gtin=${encodeURIComponent(gtin)}&limit=5`);
    rows.push(...(data?.productSummaries || []));
  }
  if (brand && model) {
    const q = encodeURIComponent(`${brand} ${model}`);
    const data = await fetchJson(`/commerce/catalog/v1_beta/product_summary/search?q=${q}&limit=8`);
    rows.push(...(data?.productSummaries || []));
  }
  return rows;
}

export async function confirmCatalogVisual({ ourUrl, catalogUrl, fetchImpl = fetch, visual } = {}) {
  if (visual) return visual;
  const key = process.env.GEMINI_API_KEY;
  if (!key || !ourUrl || !catalogUrl) return null;
  const load = async (url) => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`image_${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const type = String(res.headers.get("content-type") || "image/jpeg").split(";")[0];
    return { mime: type.startsWith("image/") ? type : "image/jpeg", data: bytes.toString("base64") };
  };
  const [ours, catalog] = await Promise.all([load(ourUrl), load(catalogUrl)]);
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: "Image 1 is the seller's real photo. Image 2 is an eBay catalog photo. Reply JSON only: {\"same\":bool,\"sameColor\":bool,\"samePack\":bool,\"damage\":bool}. same is true only when both photos are the exact same product, same color/variant, and same pack size or count. If there is any doubt, same=false. sameColor is false when the color differs. samePack is false when the count differs. damage is true when image 1 shows cracks, dents, stains, missing pieces, or other damage." },
            { inline_data: { mime_type: ours.mime, data: ours.data } },
            { inline_data: { mime_type: catalog.mime, data: catalog.data } },
          ],
        }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    },
  );
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  const text = json?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
  try {
    const parsed = JSON.parse(text);
    return {
      same: parsed.same === true,
      sameColor: parsed.sameColor === true,
      samePack: parsed.samePack === true,
      damage: parsed.damage === true,
    };
  } catch {
    return null;
  }
}

/**
 * Decide a catalog main photo. Does not throw for a skip.
 * fetchJson(path) -> catalog JSON. visualConfirm({ ourUrl, catalogUrl }) -> visual object or null.
 */
export async function matchCatalogPhoto({ unit = {}, aspects = {}, imageUrls = [], fetchJson, visualConfirm } = {}) {
  const ids = identifiersFrom({ ...unit, aspects, upc: unit.upc, brand: unit.brand, model: unit.model });
  const base = {
    sku: unit.sku || "",
    gtin: ids.gtin,
    model: ids.model,
    brand: ids.brand,
    matchType: "",
    epid: "",
    apply: false,
    reason: "",
    imageUrls: imageUrls,
  };
  if (isCollectible(unit)) return { ...base, reason: "collectible" };
  if (damageText(unit)) return { ...base, reason: "noted_damage" };
  if (!ids.gtin && !ids.modelCode) return { ...base, reason: "no_upc_or_model" };
  if (!fetchJson) return { ...base, reason: "catalog_unavailable" };
  let products = [];
  try {
    products = await searchProducts(fetchJson, ids);
  } catch (err) {
    return { ...base, reason: `catalog_error:${err instanceof Error ? err.message : String(err)}` };
  }
  const picked = pickCatalogProduct(products, { gtin: ids.gtin, brand: ids.brand, modelCode: ids.modelCode });
  if (!picked.ok) return { ...base, matchType: picked.matchType, reason: picked.reason };
  const product = picked.product;
  const ours = ourText(unit, aspects);
  const catalog = catalogText(product);
  let visual = null;
  if (visualConfirm && imageUrls[0] && product.images[0]) {
    try {
      visual = await visualConfirm({ ourUrl: imageUrls[0], catalogUrl: product.images[0] });
    } catch {
      visual = null;
    }
  }
  const decision = photoDecision({
    product,
    ourText: ours,
    catalogText: catalog,
    visual,
    damaged: false,
    collectible: false,
  });
  if (!decision.apply) {
    return { ...base, matchType: picked.matchType, epid: product.epid, reason: decision.reason };
  }
  const photos = withCatalogMainPhoto(imageUrls, product.images);
  if (!photos.ok) {
    return { ...base, matchType: picked.matchType, epid: product.epid, reason: photos.reason };
  }
  return {
    ...base,
    matchType: picked.matchType,
    epid: product.epid,
    apply: true,
    reason: photos.reason,
    imageUrls: photos.urls,
    catalogImages: product.images,
  };
}
