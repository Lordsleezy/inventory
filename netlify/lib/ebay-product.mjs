import { gtinIssue } from "./gtin.mjs";

export const NOT_APPLICABLE = "Does not apply";

/** Title-like / overly long MPNs are rejected by eBay Inventory (invalid value). */
export function looksLikeBadMpn(value) {
  const v = String(value || "").trim();
  if (!v) return true;
  if (/^does\s+not\s+apply$/i.test(v)) return false;
  if (v.length > 40) return true;
  if (v.split(/\s+/).length > 4) return true;
  if (/sealed|complete\s+set|official\s+complete|trading\s+card|reading\s+glasses/i.test(v)) return true;
  return false;
}

export function ebayIdentifiers(unit = {}, aspects = {}) {
  const pick = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const brand = pick(aspects.Brand, unit.brand);
  const rawMpn = pick(aspects.MPN, unit.model);
  const rawUpc = Object.hasOwn(aspects, "UPC") ? String(aspects.UPC ?? "").trim() : String(unit.upc ?? "").trim();
  const normalize = (value) => !value || /^does\s+not\s+apply$/i.test(value) ? NOT_APPLICABLE : value;
  const upcIssue = /^does\s+not\s+apply$/i.test(rawUpc) ? null : gtinIssue(rawUpc);
  return {
    brand,
    mpn: looksLikeBadMpn(rawMpn) ? NOT_APPLICABLE : normalize(rawMpn),
    upc: upcIssue ? null : rawUpc ? normalize(rawUpc) : null,
    upcIssue,
    validBrand: Boolean(brand && !/^(?:unknown|does\s+not\s+apply|n\/?a)$/i.test(brand)),
  };
}

export function ebayDescription(description, sku) {
  const body = String(description || "")
    .replace(/\n\s*This unit \(Floor\):[\s\S]*$/i, "")
    .replace(/\n\s*Sold as-is\. Local pickup unless arranged\.\s*$/i, "")
    .replace(/\n\s*(?:SKU\s*)?\d{5}\s*$/i, "")
    .trim();
  return `${body}\n\n${sku}`.trim();
}
