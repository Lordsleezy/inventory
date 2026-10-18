/**
 * ikonikdeals2026 listing standards.
 * Open-box condition (collectibles keep theirs), one clearance footer,
 * and catalog photos only on an exact identifier match.
 * Never changes price, title, quantity, shipping, or category.
 */
import { gtinIssue } from "./gtin.mjs";

export const CLEARANCE_FOOTER_TEXT =
  "Open-box clearance item. Item may show signs of use or handling, although it shouldn't. If there are any issues, please reach out to us through eBay messages before leaving feedback and we'll make it right.";

export const CLEARANCE_FOOTER_MARK = "Open-box clearance item. Item may show signs of use or handling";

export const SELLING_USER = "ikonikdeals2026";
export const PERSONAL_USER = "pgg124-5";

const COLOR_WORDS = [
  "black", "white", "red", "blue", "green", "pink", "purple", "yellow", "orange", "brown",
  "grey", "gray", "silver", "gold", "beige", "navy", "teal", "ivory", "cream", "stainless",
  "charcoal", "burgundy", "maroon", "tan", "khaki", "coral", "mint", "copper", "bronze",
];

const COLLECTIBLE = /\b(trading cards?|sports cards?|pokemon|pokémon|yu-?gi-?oh|magic\s*:?\s*the\s*gathering|\bmtg\b|comic books?|\bcomics?\b|funko|action figures?|figurines?|vinyl records?|phonograph|\blps?\b|33\s*rpm|45\s*rpm)\b/i;

const DAMAGE = /\b(damaged|damage|broken|cracked|dented|dents?|torn|stained|stains?|chipped|crushed|for parts|not working|water damage|scratched|scratches|scratch)\b/i;

export function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normCode(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function aspectText(aspects) {
  if (!aspects || typeof aspects !== "object") return "";
  const parts = [];
  for (const [name, value] of Object.entries(aspects)) {
    const values = Array.isArray(value) ? value : [value];
    parts.push(name, ...values.map((v) => (v == null ? "" : String(v))));
  }
  return parts.join(" ");
}

export function isCollectible(input = {}) {
  if (input.is_collectible === true || input.isCollectible === true) return true;
  const blob = [
    input.title,
    input.category,
    input.categoryName,
    input.category_name,
    aspectText(input.aspects),
  ].join(" ");
  return COLLECTIBLE.test(blob);
}

export function damageText(input = {}) {
  const blob = [input.title, input.conditionDescription, input.condition_description, input.defect_notes, input.defectNotes]
    .filter(Boolean)
    .join(" ")
    .replace(/scratch[- ]resistant/gi, " ");
  return DAMAGE.test(blob);
}

export function appendClearanceFooter(description) {
  const raw = String(description ?? "");
  if (raw.includes(CLEARANCE_FOOTER_MARK)) return raw;
  const trimmed = raw.replace(/\s+$/, "");
  const html = `<div style="font-size:12px;line-height:1.35;margin-top:16px">${CLEARANCE_FOOTER_TEXT}</div>`;
  if (!trimmed) return html;
  return `${trimmed}\n${html}`;
}

export function stripClearanceFooter(description) {
  return String(description ?? "")
    .replace(/<div[^>]*>\s*Open-box clearance item\.[\s\S]*?<\/div>\s*/gi, "")
    .replace(/\n*Open-box clearance item\. Item may show signs of use or handling[\s\S]*$/i, "")
    .trim();
}

function byName(allowed, test) {
  return (allowed || []).find((row) => test(norm(row.name))) || null;
}

/**
 * Open box when the category offers it. Otherwise the closest New other.
 * Returns null when neither exists — callers leave the current condition and log it.
 */
export function clearanceCondition(allowed) {
  const list = allowed || [];
  const open = byName(list, (n) => n.includes("open box"));
  if (open) return { conditionId: String(open.conditionId), name: open.name, fallback: false, reason: "open_box" };
  const namedOther = byName(list, (n) => n.includes("new other") || n.includes("new  other"));
  if (namedOther) {
    return { conditionId: String(namedOther.conditionId), name: namedOther.name, fallback: true, reason: "new_other" };
  }
  const id1500 = list.find((row) => String(row.conditionId) === "1500");
  if (id1500) {
    const openName = /open box/i.test(id1500.name || "");
    return {
      conditionId: "1500",
      name: id1500.name || "New other",
      fallback: !openName,
      reason: openName ? "open_box" : "new_other",
    };
  }
  return null;
}

export function colorWords(text) {
  const n = ` ${norm(text)} `;
  const found = [];
  for (const word of COLOR_WORDS) {
    if (n.includes(` ${word} `)) found.push(word === "grey" ? "gray" : word);
  }
  return [...new Set(found)];
}

export function colorsConflict(aText, bText) {
  const a = new Set(colorWords(aText));
  const b = new Set(colorWords(bText));
  if (!a.size || !b.size) return false;
  for (const word of a) if (b.has(word)) return false;
  return true;
}

export function packCount(text) {
  const s = String(text || "").toLowerCase();
  const patterns = [
    /\b(\d+)\s*[- ]?(?:pack|pk|count|ct)\b/,
    /\bpack of\s*(\d+)\b/,
    /\bset of\s*(\d+)\b/,
    /\b(\d+)\s*[- ]?pack\b/,
  ];
  for (const re of patterns) {
    const match = s.match(re);
    if (match) {
      const n = Number(match[1]);
      if (n > 0 && n < 500) return n;
    }
  }
  return null;
}

export function packsConflict(aText, bText) {
  const a = packCount(aText);
  const b = packCount(bText);
  if (a == null || b == null) return false;
  return a !== b;
}

export function brandsMatch(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb || na.length < 2 || nb.length < 2) return false;
  if (na === nb) return true;
  return nb.includes(na) || na.includes(nb);
}

export function validGtin(value) {
  const code = digits(value);
  if (!code) return "";
  if (gtinIssue(code)) return "";
  return code;
}

export function identifiersFrom(input = {}) {
  const aspects = input.aspects || {};
  const pick = (...keys) => {
    for (const key of keys) {
      const raw = aspects[key] ?? aspects[key.toLowerCase()] ?? aspects[key.toUpperCase()];
      const value = Array.isArray(raw) ? raw[0] : raw;
      const text = String(value || "").trim();
      if (text && !/^does\s+not\s+apply$/i.test(text)) return text;
    }
    return "";
  };
  const gtin = validGtin(pick("UPC", "EAN", "GTIN", "ISBN") || input.upc || input.gtin || "");
  const model = pick("MPN", "Model", "Manufacturer Part Number") || String(input.model || "").trim();
  const brand = pick("Brand") || String(input.brand || "").trim();
  const modelCode = normCode(model);
  return {
    gtin,
    model: modelCode.length >= 4 ? model : "",
    modelCode: modelCode.length >= 4 ? modelCode : "",
    brand,
  };
}

function productGtins(product) {
  const raw = product?.gtin ?? product?.gtins ?? product?.gtinValues ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((value) => digits(value)).filter(Boolean);
}

function productImages(product) {
  const urls = [];
  const add = (url) => {
    const text = String(url || "").trim();
    if (!text || urls.includes(text)) return;
    try {
      const host = new URL(text).hostname;
      if (!/(^|\.)ebayimg\.com$/i.test(host) && !/(^|\.)ebaystatic\.com$/i.test(host)) return;
      urls.push(text);
    } catch {
      /* ignore non-urls */
    }
  };
  add(product?.image?.imageUrl || product?.imageUrl);
  for (const row of product?.additionalImages || []) add(row?.imageUrl || row);
  return urls;
}

export function normalizeCatalogProduct(product) {
  const aspects = {};
  for (const row of product?.aspects || []) {
    const name = row?.localizedName || row?.name;
    const values = row?.localizedValues || row?.values || [];
    if (name && values.length) aspects[name] = values.map(String);
  }
  return {
    epid: String(product?.epid || product?.product?.epid || "").trim(),
    title: String(product?.title || "").trim(),
    brand: String(product?.brand || aspects.Brand?.[0] || "").trim(),
    mpn: String(product?.mpn || aspects.MPN?.[0] || "").trim(),
    gtins: productGtins(product),
    images: productImages(product),
    aspects,
  };
}

export function pickCatalogProduct(products, { gtin, brand, modelCode } = {}) {
  const rows = (products || []).map(normalizeCatalogProduct).filter((row) => row.epid);
  if (gtin) {
    const hits = rows.filter((row) => row.gtins.some((code) => code === gtin || code.endsWith(gtin) || gtin.endsWith(code)));
    const unique = [...new Map(hits.map((row) => [row.epid, row])).values()];
    const exact = unique.filter((row) => row.gtins.includes(gtin) || row.gtins.some((code) => code.replace(/^0+/, "") === gtin.replace(/^0+/, "")));
    const pool = exact.length ? exact : unique;
    if (pool.length !== 1) {
      return { ok: false, reason: pool.length ? "multiple_upc_matches" : "upc_not_in_catalog", matchType: "upc" };
    }
    return { ok: true, product: pool[0], matchType: "upc" };
  }
  if (!modelCode) return { ok: false, reason: "no_upc_or_model", matchType: "" };
  const hits = rows.filter((row) => normCode(row.mpn) === modelCode && brandsMatch(brand, row.brand));
  const unique = [...new Map(hits.map((row) => [row.epid, row])).values()];
  if (unique.length !== 1) {
    return { ok: false, reason: unique.length ? "multiple_model_matches" : "model_not_exact", matchType: "model" };
  }
  return { ok: true, product: unique[0], matchType: "model" };
}

/**
 * Whether a confirmed catalog product may become the main photo.
 * visual must be { same, sameColor, samePack, damage } from a look at both images.
 * Missing visual is not a match.
 */
export function photoDecision({ product, ourText, catalogText, visual, damaged, collectible }) {
  if (collectible) return { apply: false, reason: "collectible" };
  if (damaged) return { apply: false, reason: "visible_or_noted_damage" };
  if (!product?.images?.length) return { apply: false, reason: "catalog_has_no_ebay_image" };
  if (colorsConflict(ourText, catalogText)) return { apply: false, reason: "color_mismatch" };
  if (packsConflict(ourText, catalogText)) return { apply: false, reason: "pack_size_mismatch" };
  if (!visual || visual.same !== true || visual.sameColor !== true || visual.samePack !== true || visual.damage === true) {
    return { apply: false, reason: visual?.damage ? "visible_damage_in_photo" : "visual_not_confirmed" };
  }
  return { apply: true, reason: "confirmed", images: product.images };
}

export function withCatalogMainPhoto(existingUrls, catalogImages) {
  const ours = (existingUrls || []).map(String).filter(Boolean);
  const catalog = (catalogImages || []).map(String).filter(Boolean);
  if (!catalog.length) return { ok: false, reason: "no_catalog_image", urls: ours };
  const primary = catalog[0];
  const rest = ours.filter((url) => url !== primary);
  if (rest.length) return { ok: true, reason: "catalog_plus_existing", urls: [primary, ...rest].slice(0, 12) };
  if (catalog.length >= 2) return { ok: true, reason: "two_catalog_photos", urls: catalog.slice(0, 12) };
  return { ok: false, reason: "need_two_photos", urls: ours };
}

const FORBIDDEN_REVISE = ["Title", "StartPrice", "BuyItNowPrice", "Quantity", "PrimaryCategory", "ShippingDetails", "SellerProfiles", "ItemSpecifics", "SKU"];

export function reviseStandardsXml({ itemId, description, conditionId, pictureUrls } = {}) {
  if (!itemId) throw new Error("item id required");
  const parts = [`<ItemID>${xmlEscape(itemId)}</ItemID>`];
  if (description != null) {
    const safe = String(description).replace(/]]>/g, "]]]]><![CDATA[>");
    parts.push(`<Description><![CDATA[${safe}]]></Description>`);
  }
  if (conditionId) parts.push(`<ConditionID>${xmlEscape(conditionId)}</ConditionID>`);
  if (pictureUrls?.length) {
    parts.push(`<PictureDetails>${pictureUrls.map((url) => `<PictureURL>${xmlEscape(url)}</PictureURL>`).join("")}</PictureDetails>`);
  }
  const xml = `<Item>${parts.join("")}</Item>`;
  for (const tag of FORBIDDEN_REVISE) {
    if (new RegExp(`<${tag}[\\s>]`, "i").test(xml)) throw new Error(`revise would change ${tag}`);
  }
  return xml;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
