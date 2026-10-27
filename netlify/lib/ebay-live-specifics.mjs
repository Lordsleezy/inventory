/**
 * Item specifics straight from the live eBay listing (selling account). Read-only, no AI.
 * Inventory-API listings have an inventory item with product.aspects; older Trading listings are read with GetItem.
 */
// The eBay modules load only when a real call is made, so the pure parts (and tests) need no runtime packages.

/** { Name: ["v1","v2"] } with blank names/values dropped. */
export function normalizeLiveAspects(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [name, value] of Object.entries(raw)) {
    const key = String(name || "").trim();
    const values = (Array.isArray(value) ? value : [value]).map((v) => String(v ?? "").trim()).filter(Boolean);
    if (key && values.length) out[key] = values;
  }
  return out;
}

/** { categoryId, aspects } for a unit that is live on eBay, or null. */
export async function liveSpecificsForUnit(storeId, sku, deps = {}) {
  const inspect = deps.inspect || (async (...a) => (await import("./ebay.mjs")).inspectLiveSku(...a));
  const trading = deps.trading || (async (itemId) => {
    const { resolveEbayAccount } = await import("./ebay.mjs");
    const { userTokenForAccount } = await import("./ebay-accounts.mjs");
    const { getTradingItem } = await import("./ebay-trading.mjs");
    const account = await resolveEbayAccount(storeId, { role: "selling" });
    return getTradingItem(await userTokenForAccount(account), itemId);
  });
  const live = await inspect(storeId, sku);
  if (!live || live.floorStatus !== "listed") return null;
  let aspects = normalizeLiveAspects(live.rawAspects);
  let categoryId = live.categoryId ? String(live.categoryId) : null;
  if (!Object.keys(aspects).length && /^\d+$/.test(String(live.listingId || ""))) {
    const item = await trading(String(live.listingId));
    aspects = normalizeLiveAspects(item?.aspects);
    categoryId = categoryId || (item?.categoryId ? String(item.categoryId) : null);
  }
  if (!Object.keys(aspects).length && !categoryId) return null;
  return { categoryId, aspects };
}
