/**
 * What a marketplace needs before a unit can be pushed.
 * eBay required aspects come from Taxonomy responses already stored on ebay_drafts
 * (Brand, Type, Model, and the category's other required specifics).
 * Amazon list/create uses the Listings Items product-type requirements and VALIDATION_PREVIEW.
 * TikTok's create-product call needs a leaf category, brand, price, real photos, and package size.
 * Unbranded is a real value only when someone chose it. Generic / Unknown are never a brand.
 */

const JUNK_BRAND = /^(?:generic|unknown|n\/?a|does\s+not\s+apply)$/i;

export function brandProblem(brand) {
  const value = String(brand || "").trim();
  if (!value) return "missing";
  if (JUNK_BRAND.test(value)) return "invalid";
  return null;
}

function text(value) {
  return String(value ?? "").trim();
}

export function aspectText(aspects, name) {
  const raw = aspects?.[name];
  if (Array.isArray(raw)) return text(raw.find(Boolean));
  return text(raw);
}

export function missingRequiredAspects(aspects, defs = []) {
  const missing = [];
  for (const def of defs || []) {
    const required = def?.required === true || def?.required === "true";
    const name = text(def?.name);
    if (!required || !name) continue;
    if (/^(brand|upc|mpn)$/i.test(name)) continue;
    if (!aspectText(aspects, name)) missing.push(name);
  }
  return missing;
}

const SECTION = {
  brand: "missing-brand",
  category: "missing-category",
  specifics: "missing-category",
  condition: "missing-condition",
  price: "missing-price",
  photos: "missing-photo",
  spec: "missing-spec",
  upc: "missing-upc",
  amazon: "missing-upc",
};

/**
 * Gaps that block `channel`. Pass aspectDefs from the eBay draft when we have them.
 * amazonBlocked is the not-on-Amazon reason, already decided by the catalog match.
 */
export function channelGaps(unit = {}, { channel, photoCount = 0, aspectDefs = null, amazonBlocked = null } = {}) {
  const gaps = [];
  const brand = brandProblem(unit.brand);
  if (brand) gaps.push({ code: "brand", label: "brand", blocks: ["ebay", "amazon", "tiktok"] });

  const specs = unit.listing_specs && typeof unit.listing_specs === "object" ? unit.listing_specs : {};
  const hasCategory = text(unit.category) || text(specs.ebay_category_id) || text(unit.ebay_category);
  if (!hasCategory) gaps.push({ code: "category", label: "category", blocks: ["ebay", "tiktok"] });

  if (!text(unit.condition)) gaps.push({ code: "condition", label: "condition", blocks: ["ebay", "amazon", "tiktok"] });
  if (!(Number(unit.ask_cents) > 0)) gaps.push({ code: "price", label: "price", blocks: ["ebay", "amazon", "tiktok", "depop"] });
  if (!(Number(photoCount) > 0)) gaps.push({ code: "photos", label: "photos", blocks: ["ebay", "amazon", "tiktok"] });

  const dimsOk = [unit.package_weight_lb, unit.package_length_in, unit.package_width_in, unit.package_height_in]
    .every((n) => Number(n) > 0);
  if (!dimsOk) gaps.push({ code: "spec", label: "weight", blocks: ["ebay", "amazon", "tiktok"] });
  if (!text(unit.upc)) gaps.push({ code: "upc", label: "UPC", blocks: ["ebay", "amazon"] });

  const aspects = specs.ebay_aspects || unit.aspects || {};
  const missingAspects = missingRequiredAspects(aspects, aspectDefs || unit.aspect_defs || []);
  if (missingAspects.length) {
    gaps.push({
      code: "specifics",
      label: missingAspects.slice(0, 3).join(", "),
      blocks: ["ebay"],
      aspects: missingAspects,
    });
  }
  if (amazonBlocked) gaps.push({ code: "amazon", label: "Amazon catalog", blocks: ["amazon"], detail: amazonBlocked });

  const ch = text(channel).toLowerCase();
  const mine = ch ? gaps.filter((gap) => gap.blocks.includes(ch)) : gaps;
  const labels = [...new Set(mine.map((gap) => gap.label).filter(Boolean))];
  const section = mine[0] ? SECTION[mine[0].code] || "missing-brand" : null;
  return {
    ready: mine.length === 0,
    gaps: mine,
    summary: labels,
    reason: labels.length ? `Needs: ${labels.join(", ")}` : null,
    section,
  };
}
