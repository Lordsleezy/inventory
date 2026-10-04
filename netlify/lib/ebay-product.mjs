export const NOT_APPLICABLE = "Does not apply";

export function ebayIdentifiers(unit = {}, aspects = {}) {
  const pick = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
  const brand = pick(aspects.Brand, unit.brand);
  const rawMpn = pick(aspects.MPN, unit.model);
  const rawUpc = pick(aspects.UPC, unit.upc);
  const normalize = (value) => !value || /^does\s+not\s+apply$/i.test(value) ? NOT_APPLICABLE : value;
  return {
    brand,
    mpn: normalize(rawMpn),
    upc: normalize(rawUpc),
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
