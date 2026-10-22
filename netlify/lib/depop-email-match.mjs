/**
 * Match a Depop sale email to one Floor listing row created by Push to Depop.
 * Auto-match only when a single listing is clear. Two similar rows stay in review.
 */

const TITLE_STOP = new Set(
  "the and for with pack open box sale depop your usps shipping label confirmation item price youve have made ship sign view order thanks buyer this that from".split(
    " ",
  ),
);

const TITLE_LINE_SKIP =
  /you(?:'ve| have) made a sale|shipping label|sale confirmation|ship to|sign in|usps|item price|order total|view (?:your )?order|thanks|postage|tracking|download the|buyer protection|depop fee|sold for|@|^\d{1,6}\s+\S+\s+(?:st|street|rd|road|ave|avenue|blvd|dr|drive|ln|lane|way|ct|court)\b/i;

export function emailPhotoUrls(html, text) {
  const raw = `${html || ""}\n${text || ""}`;
  const urls = [];
  for (const match of raw.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) urls.push(decodeUrl(match[1]));
  for (const match of raw.matchAll(/https?:\/\/[^\s"'<>]+/gi)) urls.push(decodeUrl(match[0]));
  return [...new Set(urls)];
}

export function depopProductIds(blob) {
  const ids = new Set();
  const text = String(blob || "");
  for (const match of text.matchAll(/depop\.com\/products\/[^\s"'<>]*?(\d{5,})/gi)) ids.add(match[1]);
  for (const match of text.matchAll(/media(?:-photos)?\.depop\.com\/[^\s"'<>]*?\/(\d{6,})(?:[/?]|$)/gi)) ids.add(match[1]);
  return [...ids];
}

/** First product-looking line after the sale headline, ignoring the shipping-label subject. */
export function depopItemTitle(subject, text) {
  const lines = String(text || "")
    .replace(/<[^>]+>/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const start = lines.findIndex((line) => /you(?:'ve| have) made a sale/i.test(line));
  const window = start >= 0 ? lines.slice(start + 1, start + 10) : lines;
  for (const line of window) {
    if (line.length < 8 || line.length > 140) continue;
    if (!/[a-z]/i.test(line)) continue;
    if (TITLE_LINE_SKIP.test(line)) continue;
    if (/^\$\s?\d/.test(line)) continue;
    // "Ship to" blocks are a person's name, not the listing title.
    if (/^[A-Z][a-z]+(?: [A-Z][a-z]+){1,2}$/.test(line)) continue;
    if (/\b(?:st|street|rd|road|ave|avenue|blvd|dr|drive|ln|lane|way|ct|court)\b\.?$/i.test(line)) continue;
    if (/,\s*[A-Z]{2}\s+\d{5}/.test(line)) continue;
    if (line.toLowerCase() === String(subject || "").trim().toLowerCase()) continue;
    return line.slice(0, 250);
  }
  return null;
}

export function titleScore(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const shared = a.filter((word) => setB.has(word)).length;
  if (shared < 2 && !(shared === 1 && (a.length === 1 || b.length === 1) && [...a, ...b].some((word) => word.length > 6))) {
    return shared / Math.max(a.length, b.length);
  }
  return shared / Math.max(a.length, b.length);
}

function priceClose(priceCents, askCents) {
  if (priceCents == null || askCents == null) return false;
  const price = Number(priceCents);
  const ask = Number(askCents);
  if (!Number.isFinite(price) || !Number.isFinite(ask) || price <= 0 || ask <= 0) return false;
  return Math.abs(price - ask) <= 100;
}

function photoHits(urls, listing) {
  const blob = (urls || []).join("\n").toLowerCase();
  if (!blob) return false;
  const listingId = String(listing?.listing_id || "").trim();
  if (listingId && listingId.length >= 5 && blob.includes(listingId.toLowerCase())) return true;
  for (const path of listing?.photo_paths || []) {
    const name = String(path || "").trim().toLowerCase();
    if (name.length >= 8 && blob.includes(name)) return true;
    const file = name.split("/").pop();
    if (file && file.length >= 8 && blob.includes(file)) return true;
  }
  return false;
}

/**
 * @returns {{ sku: string, listing_id: string|null, via: string } | null}
 */
export function matchDepopListing({ title, priceCents, urls, productIds }, listings) {
  const rows = Array.isArray(listings) ? listings : [];
  const ids = new Set((productIds || []).map((id) => String(id)));
  const idHits = rows.filter((row) => row.listing_id && ids.has(String(row.listing_id)));
  if (idHits.length === 1) return hit(idHits[0], "listing_id");
  if (idHits.length > 1) return null;

  const scored = [];
  for (const listing of rows) {
    const score = titleScore(title, listing.title);
    const priceOk = priceClose(priceCents, listing.ask_cents);
    const photoOk = photoHits(urls, listing);
    const titleOk = score >= 0.72;
    if (titleOk && (priceOk || photoOk)) scored.push({ listing, score, priceOk, photoOk });
  }
  scored.sort((a, b) => b.score - a.score || Number(b.photoOk) - Number(a.photoOk) || Number(b.priceOk) - Number(a.priceOk));
  const best = scored[0];
  if (!best) return null;
  const second = scored[1];
  if (second && second.score >= best.score - 0.15) {
    const photoSeparates = best.photoOk && !second.photoOk;
    const priceSeparates = best.priceOk && !second.priceOk && second.score <= best.score - 0.08;
    if (!photoSeparates && !priceSeparates) return null;
  }
  return hit(best.listing, best.photoOk && !best.priceOk ? "title_photo" : best.photoOk ? "title_price_photo" : "title_price");
}

function hit(listing, via) {
  return { sku: String(listing.sku), listing_id: listing.listing_id ? String(listing.listing_id) : null, via };
}

function tokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !TITLE_STOP.has(word));
}

function decodeUrl(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/[),.;]+$/g, "");
}
