import { gtinIssue } from "./gtin.mjs";

export const NOT_APPLICABLE = "Does not apply";

export function ebayIdentifiers(unit = {}, aspects = {}) {
  const pick = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const brand = pick(aspects.Brand, unit.brand);
  const rawMpn = pick(aspects.MPN, unit.model);
  const rawUpc = Object.hasOwn(aspects, "UPC") ? String(aspects.UPC ?? "").trim() : String(unit.upc ?? "").trim();
  const normalize = (value) => !value || /^does\s+not\s+apply$/i.test(value) ? NOT_APPLICABLE : value;
  const upcIssue = /^does\s+not\s+apply$/i.test(rawUpc) ? null : gtinIssue(rawUpc);
  return {
    brand,
    mpn: normalize(rawMpn),
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
