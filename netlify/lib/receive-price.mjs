/** Exact, whole-package asking prices for the photo receiving reference. */
import { createHash } from 'node:crypto';
const words = value => String(value || '').toLowerCase().replace(/&/g, ' and ')
  .replace(/[^a-z0-9.]+/g, ' ').trim().split(/\s+/).filter(Boolean);

function printedSize(value) {
  const normalized = String(value || '').toLowerCase()
    .replace(/\bfluid\s+ounces?\b/g, 'fl oz').replace(/\bfl[.\s]*oz[.]?/g, 'fl oz')
    .replace(/\bounces?\b/g, 'oz').replace(/\bmillilit(?:er|re)s?\b/g, 'ml')
    .replace(/\bkilograms?\b/g, 'kg').replace(/\bgrams?\b/g, 'g').replace(/\bpounds?\b/g, 'lb');
  const match = normalized.match(/\b(\d+(?:\.\d+)?)[\s-]*(fl\s*oz|oz|ml|l|g|kg|lb)\b/);
  return match ? { amount: Number(match[1]), unit: match[2].replace(/\s+/g, '') === 'floz' ? 'oz' : match[2].replace(/\s+/g, '') } : null;
}

function packCount(value) {
  const text = String(value || '').toLowerCase();
  const match = text.match(/\b(?:pack|case|box|set)\s*(?:of\s*)?(\d+)\b|\b(\d+)\s*(?:-?\s*(?:pack|count|ct)|pk|cans?|bottles?|\/\s*carton)\b|\b(\d+)\s*[x×]\s*\d+(?:\.\d+)?\s*(?:fl\s*)?oz\b/);
  return match ? Number(match[1] || match[2] || match[3]) : null;
}

function identityPack(identity) {
  return Math.max(1, Number(identity.unit_count) || 1, packCount(identity.title) || 1, packCount(identity.size) || 1);
}

export function receivePriceCacheKey(identity) {
  if (!identity?.brand || !identity?.title) return null;
  const parts = ['upc','brand','title','model','variant','size','color'].map(key =>
    String(identity[key] || '').trim().toLowerCase());
  return createHash('sha256').update(JSON.stringify(['receive-price-v6',...parts,identityPack(identity)])).digest('hex');
}

export function comparablePrices(prices, identity) {
  const expectedPack = identityPack(identity);
  const expectedSize = printedSize(identity.size) || printedSize(identity.title);
  const brand = words(identity.brand).join(' ');
  const variant = words(identity.variant).filter(word => word !== 'and');
  const afterBrand = String(identity.title || '').replace(new RegExp(`^${String(identity.brand || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '');
  const line = words(afterBrand.split(/[,–—]/)[0]).filter(word =>
    !['the', 'and', 'with', 'for', 'spray', 'freshener', 'new'].includes(word) && !/^\d/.test(word)).slice(0, 2);
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
    if (line.length && !line.some(word => listedWords.includes(word))) return false;
    const model = String(identity.model || '').toLowerCase().trim();
    // If the listing prints a manufacturer model, it must agree. GTIN searches may omit it.
    const listedModels = (listed.match(/\b[a-z][a-z0-9]*(?:[/-][a-z0-9]+)*\b/g) || [])
      .filter(word => word.length >= 4 && /\d/.test(word));
    const manufacturerModel = /^(?=.*[a-z])(?=.*\d)[a-z0-9/-]{4,}$/.test(model);
    if (manufacturerModel && listedModels.length && !listedModels.includes(model)) return false;
    const size = printedSize(price.product_name) || printedSize(listedUrl);
    if (expectedSize && (!size || expectedSize.unit !== size.unit || Math.abs(expectedSize.amount - size.amount) > 0.05)) return false;
    const namedPack = packCount(price.product_name) || packCount(listedUrl);
    if (namedPack && namedPack !== expectedPack) return false;
    if (Number(price.pack_size || namedPack || 1) !== expectedPack) return false;
    const canonical = String(price.merchant_domain || new URL(url).hostname).toLowerCase().replace(/^www\./, '');
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

/** Recorded merchant offers for this barcode; never convert a multipack to a unit price. */
export function upcOfferPrices(catalog, identity) {
  if (!catalog?.found) return [];
  return comparablePrices((catalog.offers || []).filter(offer =>
    (!offer.condition || /^new$/i.test(offer.condition)) &&
    (!offer.currency || /^USD$/i.test(offer.currency)) &&
    !/\.ca\b|canada/i.test(`${offer.domain || ''} ${offer.merchant || ''}`)).map(offer => ({
    store: `UPCitemdb · ${offer.merchant || offer.domain || 'merchant'}`,
    product_name: offer.title || catalog.title, url: offer.link, merchant_domain: offer.domain || offer.merchant,
    price_cents: Math.round(Number(offer.price) * 100),
  })), identity);
}

export function medianReference(prices, identity) {
  const listings = comparablePrices(prices, identity);
  const cents = listings.map(price => price.price_cents).sort((a, b) => a - b);
  const mid = Math.floor(cents.length / 2);
  return { kind: 'asking', count: cents.length,
    median_cents: cents.length >= 3 ? (cents.length % 2 ? cents[mid] : Math.round((cents[mid - 1] + cents[mid]) / 2)) : null,
    low_cents: cents.length ? cents[0] : null, high_cents: cents.length ? cents.at(-1) : null,
    highest_retail: listings.length ? listings.reduce((highest, listing) => listing.price_cents > highest.price_cents ? listing : highest) : null,
    listings };
}

/** A generated price counts only when its live retailer page confirms the exact item and amount. */
export async function verifyRetailListings(prices, identity, { fetchImpl = fetch } = {}) {
  const candidates = (Array.isArray(prices) ? prices : []).filter(price =>
    Number(price.pack_size || 1) === identityPack(identity) && !price.approximate && !price.size_mismatch);
  const checked = await Promise.all(candidates.slice(0, 8).map(async candidate => {
    try {
      const response = await fetchImpl(candidate.url, { redirect: 'follow', signal: AbortSignal.timeout(3500),
        headers: { 'user-agent': 'Mozilla/5.0 FloorPriceResearch/1.0' } });
      if (!response.ok || !String(response.headers.get('content-type') || '').includes('text/html')) return null;
      const final = new URL(response.url);
      if (!/^https:$/.test(final.protocol) || /vertexaisearch|public\.cj\.com|upcitemdb\.com/.test(final.hostname)) return null;
      const html = (await response.text()).slice(0, 3_000_000);
      const pageName = (html.match(/<title[^>]*>([^<]{5,250})<\/title>/i)?.[1] ||
        html.match(/<h1[^>]*>([^<]{5,250})<\/h1>/i)?.[1] || '')
        .replace(/&amp;/gi, '&').replace(/&#39;/gi, "'").replace(/&quot;/gi, '"');
      const pageIdentity = `${pageName} ${final.pathname.replace(/[-_]/g, ' ')}`;
      if (!comparablePrices([{ ...candidate, product_name: pageIdentity, url: final.href }], identity).length) return null;
      const dollars = (candidate.price_cents / 100).toFixed(2);
      if (!html.includes(`$${dollars}`) && !html.includes(`"${dollars}"`) &&
        !html.includes(`>${dollars}<`)) return null;
      return { ...candidate, product_name: pageName, url: final.href };
    } catch { return null; }
  }));
  return comparablePrices(checked.filter(Boolean), identity);
}
