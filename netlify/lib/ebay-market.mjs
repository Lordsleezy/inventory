import { parseListingSpecs } from "./listing-copy.mjs";
import { lookupMarket } from "./video-scan.mjs";

function eachCents(row) {
  return row.price_cents / Math.max(1, Number(row.pack_size) || 1);
}

export function summarizeMarket(kind, prices) {
  const usable = (prices || []).filter((row) => row?.price_cents > 0 && !row.approximate && !row.size_mismatch);
  if (!usable.length || (kind !== "retail" && kind !== "sold")) return null;
  if (kind === "retail") {
    const top = usable.reduce((best, row) => (eachCents(row) > eachCents(best) ? row : best));
    return {
      kind: "retail",
      cents: Math.round(eachCents(top)),
      store: String(top.store || ""),
      url: String(top.url || ""),
      count: usable.length,
    };
  }
  const cents = Math.round(usable.reduce((sum, row) => sum + eachCents(row), 0) / usable.length);
  return { kind: "sold", cents, store: "", url: "", count: usable.length };
}

export async function ensureMarket(sb, storeId, unit) {
  const specs = parseListingSpecs(unit?.listing_specs) || {};
  const saved = specs.market;
  if (saved?.cents && Date.now() - Date.parse(saved.checked_at || 0) < 30 * 86400_000) return saved;
  const storedRetail = summarizeMarket("retail", unit?.retail_price_sources);
  if (storedRetail) return { ...storedRetail, checked_at: saved?.checked_at || new Date().toISOString() };
  const found = await lookupMarket(sb, storeId, {
    brand: unit?.brand,
    title: unit?.ebay_title || unit?.title,
    model: unit?.model,
  });
  const summary = summarizeMarket(found.kind, found.prices);
  const market = summary
    ? { ...summary, checked_at: found.checked_at }
    : { kind: "none", cents: null, store: "", url: "", count: 0, checked_at: found.checked_at };
  await sb.from("units").update({
    listing_specs: { ...specs, market },
    updated_at: new Date().toISOString(),
  }).eq("store_id", storeId).eq("sku", unit.sku);
  console.info("ebay_market", JSON.stringify({
    sku: unit.sku, kind: market.kind, cents: market.cents, queries: found.queries, reused: found.reused,
  }));
  return market;
}
