/** Exact, whole-package asking prices for the photo receiving reference. */
const words = value => String(value || '').toLowerCase().replace(/&/g, ' and ')
  .replace(/[^a-z0-9.]+/g, ' ').trim().split(/\s+/).filter(Boolean);

function printedSize(value) {
  const match = String(value || '').toLowerCase().match(/\b(\d+(?:\.\d+)?)\s*(fl\s*oz|oz|ml|l|g|kg|lb|ct|count)\b/);
  return match ? { amount: Number(match[1]), unit: match[2].replace(/\s+/g, '') === 'floz' ? 'oz' : match[2].replace(/\s+/g, '') } : null;
}

function packCount(value) {
  const text = String(value || '').toLowerCase();
  const match = text.match(/\b(?:pack|case|box|set)\s*(?:of\s*)?(\d+)\b|\b(\d+)\s*(?:-?\s*pack|pk|cans?|bottles?)\b|\b(\d+)\s*[x×]\s*\d+(?:\.\d+)?\s*(?:fl\s*)?oz\b/);
  return match ? Number(match[1] || match[2] || match[3]) : null;
}

function identityPack(identity) {
  return Math.max(1, Number(identity.unit_count) || 1, packCount(identity.title) || 1);
}

export function comparablePrices(prices, identity) {
  const expectedPack = identityPack(identity);
  const expectedSize = printedSize(identity.size) || printedSize(identity.title);
  const brand = words(identity.brand).join(' ');
  const variant = words(identity.variant).filter(word => word !== 'and');
  const afterBrand = String(identity.title || '').replace(new RegExp(`^${String(identity.brand || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '');
  const line = words(afterBrand.split(/[,–—]/)[0]).filter(word =>
    !['the', 'and', 'with', 'for', 'spray', 'freshener', 'air', 'new'].includes(word) && !/^\d/.test(word)).slice(0, 2);
  const seen = new Set();
  return (Array.isArray(prices) ? prices : []).filter(price => {
    if (!Number.isInteger(price.price_cents) || price.price_cents <= 0 || price.approximate || price.size_mismatch) return false;
    const url = String(price.url || '');
    if (!/^https:\/\//i.test(url)) return false;
    let listedUrl;
    try { listedUrl = decodeURIComponent(url).toLowerCase(); }
    catch { return false; }
    const listed = String(price.product_name || '').toLowerCase();
    const listedWords = words(listed);
    if (brand && !listed.includes(brand)) return false;
    if (variant.length && !variant.every(word => listedWords.includes(word))) return false;
    if (line.length && !line.every(word => listedWords.includes(word))) return false;
    const size = printedSize(price.product_name) || printedSize(listedUrl);
    if (expectedSize && (!size || expectedSize.unit !== size.unit || Math.abs(expectedSize.amount - size.amount) > 0.05)) return false;
    const namedPack = packCount(price.product_name) || packCount(listedUrl);
    if (namedPack && namedPack !== expectedPack) return false;
    if (Number(price.pack_size || 1) !== expectedPack) return false;
    const canonical = new URL(url).hostname.replace(/^www\./, '');
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

export function medianReference(prices, identity) {
  const listings = comparablePrices(prices, identity);
  const cents = listings.map(price => price.price_cents).sort((a, b) => a - b);
  const mid = Math.floor(cents.length / 2);
  return { kind: 'asking', count: cents.length,
    median_cents: cents.length >= 3 ? (cents.length % 2 ? cents[mid] : Math.round((cents[mid - 1] + cents[mid]) / 2)) : null,
    low_cents: cents.length ? cents[0] : null, high_cents: cents.length ? cents.at(-1) : null,
    listings };
}
