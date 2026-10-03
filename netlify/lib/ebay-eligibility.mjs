/**
 * Who gets an eBay draft. Big/heavy uses the same category, keyword, and size rules as
 * public.unit_ship_rules. Missing box size still gets a draft ("Needs box size").
 * Alcohol and other eBay-prohibited goods never get a draft.
 */

const PROHIBITED = [
  "alcohol", "beer", "wine", "liquor", "spirits", "hard seltzer", "seltzer",
  "vodka", "whiskey", "whisky", "bourbon", "tequila", "rum", "champagne",
  "cognac", "brandy", "tobacco", "cigarette", "cigar", "vape", "firearm",
  "ammunition", "ammo",
];

function hasWord(text, phrase) {
  const esc = String(phrase || "")
    .trim()
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  if (!esc) return false;
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, "i").test(text);
}

export function prohibitedReason(unit) {
  const text = [unit?.title, unit?.brand, unit?.model, unit?.category, unit?.ebay_title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  for (const word of PROHIBITED) {
    if (hasWord(text, word)) return word;
  }
  return null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @returns {{ ok: boolean, reason: string, needsBox?: boolean }}
 */
export function ebayDraftEligibility(unit, settings = {}) {
  if (String(unit?.state || "available") !== "available") return { ok: false, reason: "Not available" };
  if (!(Number(unit?.ask_cents) > 0)) return { ok: false, reason: "No price" };
  if (!(Number(unit?.photo_count) > 0)) return { ok: false, reason: "No photo" };
  const banned = prohibitedReason(unit);
  if (banned) return { ok: false, reason: `eBay prohibits this (${banned})` };

  const categories = (settings.excludedCategories || []).map((c) => String(c).trim().toLowerCase());
  const category = String(unit?.category || "").trim().toLowerCase();
  if (category && categories.includes(category)) {
    return { ok: false, reason: `${unit.category} is a pickup-only category` };
  }
  const text = [unit?.title, unit?.brand, unit?.model, unit?.category].filter(Boolean).join(" ").toLowerCase();
  for (const keyword of settings.excludedKeywords || []) {
    if (hasWord(text, keyword)) return { ok: false, reason: `Large item ("${keyword}")` };
  }

  const length = num(unit?.package_length_in);
  const width = num(unit?.package_width_in);
  const height = num(unit?.package_height_in);
  const weight = num(unit?.package_weight_lb);
  if (!(length > 0) || !(width > 0) || !(height > 0) || !(weight > 0)) {
    return { ok: true, needsBox: true, reason: "Needs box size" };
  }
  const dims = [length, width, height].sort((a, b) => b - a);
  const maxLb = num(settings.maxWeightLb) || 70;
  const maxLen = num(settings.maxLengthIn) || 108;
  const maxLg = num(settings.maxGirthIn) || 165;
  if (weight > maxLb) return { ok: false, reason: `Package ${weight} lb is over the ${maxLb} lb limit` };
  if (dims[0] > maxLen) return { ok: false, reason: `Longest side ${dims[0]} in is over the ${maxLen} in limit` };
  const girth = dims[0] + 2 * (dims[1] + dims[2]);
  if (girth > maxLg) return { ok: false, reason: `Length + girth ${girth} in is over the ${maxLg} in limit` };
  return { ok: true, reason: "Eligible" };
}
