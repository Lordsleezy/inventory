/**
 * Listing stock photos may come from the manufacturer or the Amazon catalog.
 * Seller listing photos (eBay, Depop, and the other marketplaces) are never kept.
 */

const SELLER_HOST = /(^|\.)ebayimg\.com$|(^|\.)ebaystatic\.com$|depop\.com$|mercari\.com$|poshmark\.com$|etsy\.com$|facebook\.com$|fbcdn\.net$/i;

export function stockPhotoHost(url) {
  try {
    return new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** amazon | seller | unverified */
export function stockPhotoVerdict(url) {
  const host = stockPhotoHost(url);
  if (!host) return "unverified";
  if (SELLER_HOST.test(host)) return "seller";
  if (host.includes("media-amazon") || host.includes("images-amazon") || host.includes("ssl-images-amazon") || host.endsWith("amazon.com")) {
    return "amazon";
  }
  return "unverified";
}

/** A photo row may be { url, source } or a bare URL. Manufacturer and Costco
 * sources are explicit fetches. eBay catalog images are the one ebayimg set
 * kept, because they are the product record for that GTIN, not a seller ad. */
export function keepStockPhoto(row) {
  const url = typeof row === "string" ? row : row?.url;
  const source = typeof row === "string" ? "" : String(row?.source || "");
  if (!url || !/^https?:/i.test(url)) return false;
  const host = stockPhotoHost(url);
  if (source === "ebay_catalog") return /(^|\.)ebayimg\.com$/i.test(host);
  if (stockPhotoVerdict(url) === "seller") return false;
  if (source === "manufacturer") return true;
  if (source === "costco" || /costco|scene7/i.test(`${host} ${url}`)) return /costco|scene7/i.test(`${host} ${url}`);
  return stockPhotoVerdict(url) === "amazon";
}
