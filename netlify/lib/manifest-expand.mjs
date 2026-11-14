/** Decide which expanded manifest fields are safe to keep. Never invents a price or a UPC. */

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function words(value) {
  return new Set(clean(value).toUpperCase().split(/[^A-Z0-9]+/).filter((word) => word.length >= 4));
}

/** Keep a suggested category only when its name actually belongs to this product. */
export function categoryFits(name, categoryName) {
  const hay = clean(name).toLowerCase();
  if (!hay || !clean(categoryName)) return false;
  return clean(categoryName).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4)
    .some((word) => hay.includes(word) || hay.includes(word.replace(/s$/, "")) || hay.includes(word.replace(/es$/, "")));
}

export function imageUrlOk(url) {
  const text = String(url || "");
  return /^https:\/\//i.test(text)
    && !/\/1x1[./]|pixel|placeholder|spacer|blank\./i.test(text)
    && (/\.(jpe?g|png|webp|avif|gif)(\?|$)/i.test(text) || /ebayimg|media-amazon|images-amazon|ssl-images-amazon|costco|scene7|upcitemdb|walmartimages|goepson|ulta\.com|\/image\/|rendition|adobe\/assets|fmt=auto/i.test(text));
}

/** First image whose listing title belongs to this manifest line. A trusted barcode match skips the title check. */
export function chooseStockPhoto(lineText, candidates) {
  for (const row of candidates || []) {
    if (!imageUrlOk(row?.url)) continue;
    if (row.trusted || sharesPhotoTitle(row.title || "", lineText)) return row.url;
  }
  return "";
}

function sharesPhotoTitle(left, right) {
  if (sharesToken(left, right)) return true;
  const known = [...words(right)];
  return [...words(left)].some((word) => known.some((other) => word.length >= 4 && other.length >= 4 && (word.startsWith(other) || other.startsWith(word))));
}

export function sharesToken(left, right) {
  const known = words(right);
  return [...words(left)].some((word) => known.has(word));
}

function checkDigit(code) {
  let sum = 0;
  for (let i = code.length - 2, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(code[i]) * weight;
  }
  return Number(code.at(-1)) === (10 - (sum % 10)) % 10;
}

export function manufacturerUpc(raw) {
  const code = String(raw ?? "").replace(/\D/g, "");
  if (!/^\d{12,14}$/.test(code) || /^4999/.test(code) || !checkDigit(code)) return "";
  return code;
}

function companyBrand(vendor) {
  const name = clean(vendor);
  if (!name || /\b(LLC|INC|CORP|CO|LTD|COMPANY|DISTRIBUTING)\b/i.test(name)) return "";
  return name;
}

/**
 * Manifest brand wins. A distributor vendor is not a brand.
 * An expanded name is kept only when it is longer than the stub and shares a real word with it.
 */
export function acceptedExpansion({ description, brand, vendor, title, expandedBrand, model, manufacturerUpc: upc }) {
  const stub = clean(description);
  const full = clean(title);
  const keepTitle = full.length > stub.length && sharesToken(full, `${stub} ${brand || ""}`) ? full : "";
  const manifestBrand = clean(brand);
  const named = clean(expandedBrand);
  const brandInTitle = Boolean(keepTitle && named && keepTitle.toLowerCase().includes(named.toLowerCase()));
  const nextBrand = manifestBrand || companyBrand(vendor) || (brandInTitle || sharesToken(named, stub) ? named : "");
  const nextModel = keepTitle && clean(model) && sharesToken(model, keepTitle) ? clean(model) : "";
  return {
    expanded_title: keepTitle,
    expanded_brand: nextBrand,
    expanded_model: nextModel,
    manufacturer_upc: keepTitle ? manufacturerUpc(upc) : "",
  };
}
