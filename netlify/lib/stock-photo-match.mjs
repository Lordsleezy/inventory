import { titleScore } from "./visual-product-search.mjs";

const COLORS = ["matte black", "brushed nickel", "brushed steel", "stainless", "black", "white", "gold", "silver", "bronze", "nickel", "chrome", "brass", "gray", "grey", "blue", "red", "green", "pink"];

function colorsIn(text) {
  const lower = String(text || "").toLowerCase();
  return COLORS.filter((color) => lower.includes(color));
}

function colorConflict(wanted, title) {
  const want = String(wanted || "").toLowerCase();
  if (!want) return false;
  const found = colorsIn(title);
  if (!found.length) return false;
  return !found.some((color) => want.includes(color));
}

function brandAgrees(brand, text) {
  const token = String(brand || "").toLowerCase().split(/[^a-z0-9]+/).find((word) => word.length > 2);
  return Boolean(token) && String(text || "").toLowerCase().includes(token);
}

function accessoryMismatch(candidate, unitTitle) {
  const bad = /\b(compatible|replacement|refill|cartridge)\b/i;
  return bad.test(candidate || "") && !bad.test(unitTitle || "");
}

const GENERIC = new Set("with and for the led light lamp pack black white wireless motion security vanity mirror filtered shower set new pro item".split(" "));

function titleTokenAgrees(title, candidate) {
  const tokens = String(title || "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !GENERIC.has(word));
  const text = String(candidate || "").toLowerCase();
  return tokens.some((token) => text.includes(token));
}

function usableImage(url, page = "") {
  if (!/^https:\/\//i.test(url || "") || /aplus-media|ebayimg|depop|mercari|poshmark|etsy|facebook|fbcdn/i.test(url)) return false;
  if (/media-amazon|images-amazon|walmartimages|scene7|costco|bbystatic|thdstatic|lowes\.com|images\.philips|goepson/i.test(url)) return true;
  return /instacart\.com\/assets\/domains\/product-image/i.test(url) && /costco/i.test(page);
}

function sameProduct(brand, title, color, candidate) {
  if (accessoryMismatch(candidate, title)) return false;
  if (colorConflict(color, candidate)) return false;
  if (!brandAgrees(brand, candidate) && !titleTokenAgrees(title, candidate)) return false;
  return titleScore(`${brand || ""} ${title || ""}`.trim(), candidate) >= 0.55;
}

/** Official catalog images for this product. A compatible accessory or a different color is left out. */
export function chooseCatalogStockPhotos({ brand, title, color = "", hits = [], catalogs = [] } = {}) {
  for (const item of catalogs) {
    const blob = `${item?.brand || ""} ${item?.title || ""}`.trim();
    const images = (item?.images || []).filter((url) => usableImage(url));
    if (images.length && sameProduct(brand, title, color, blob)) return images.slice(0, 4);
  }
  const urls = [];
  for (const hit of hits) {
    if (!sameProduct(brand, title, color, hit?.title || "")) continue;
    if (usableImage(hit?.image, hit?.url)) urls.push(hit.image);
    if (urls.length >= 4) break;
  }
  return urls;
}
