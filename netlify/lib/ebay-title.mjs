/**
 * eBay listing titles: product name only.
 * SKU, Floor grade, and category stay in description / item specifics / custom label.
 */

const CONDITION_TAIL =
  String.raw`New|Brand\s*New|Open\s*box(?:\s*Unused)?|open_box|Like\s*New|Used(?:\s*[-–]\s*\w+)?|Excellent|Good|Fair|Refurbished|For\s*parts(?:\s*or\s*not\s*working)?`;

/** Drop trailing " | SKU 12345", em-dash condition/category tails, and bare "Open box" suffixes. */
export function stripSkuAndConditionFromTitle(title) {
  let t = String(title || "")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/\s*\|\s*SKU\s*#?[\w-]+\s*$/i, "");
  // name — condition — category | SKU  → drop from first condition marker through end
  t = t.replace(new RegExp(String.raw`\s*[—\-–]\s*(?:${CONDITION_TAIL})\b.*$`, "i"), "");
  // "Trash Can Open Box" / "Crockpot Open box Unused"
  t = t.replace(new RegExp(String.raw`\s+(?:${CONDITION_TAIL})\s*$`, "i"), "");
  return t.replace(/\s+/g, " ").trim();
}

export function clipEbayTitle(value) {
  const title = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}...` : title;
}

/** Build the eBay Title field from a Floor unit. Never includes SKU or condition. */
export function ebayListingTitle(unit) {
  const custom = String(unit?.ebay_title || "").trim();
  if (custom) return clipEbayTitle(stripSkuAndConditionFromTitle(custom));
  const name =
    [unit?.brand, unit?.model]
      .filter((p) => String(p || "").trim())
      .join(" ")
      .trim() ||
    String(unit?.title || "").trim() ||
    "Item";
  return clipEbayTitle(stripSkuAndConditionFromTitle(name));
}
