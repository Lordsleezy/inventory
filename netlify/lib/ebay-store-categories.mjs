/**
 * eBay store (custom) categories for Open Box Industries.
 * Pure classifier: no network, no price changes.
 *
 * Primary category is the department. Under $25 is a second category when the
 * listed price is below $25, so bargain shoppers can browse without a junk drawer.
 * Store category names must stay within eBay's 30-character limit.
 */

export const UNDER_25 = "Under $25";

export const STORE_CATEGORY_ORDER = [
  UNDER_25,
  "Kitchen & Small Appliances",
  "Kitchen & Dining",
  "Major Appliances (Pickup)",
  "Bath & Fixtures",
  "Home & Organization",
  "Health & Personal Care",
  "Electronics & Lighting",
  "Toys & Collectibles",
  "Trading Cards",
  "Vinyl & Music",
  "Seasonal & Holiday",
  "Outdoor, Sports & Travel",
];

const RULES = [
  ["Trading Cards", /\b(pokemon|pokémon|poketrivia|panini|topps|bowman|\bscore\b|blaster|blister|\btcg\b|sporting news|conlon|football cards|nba hoops|trading cards?)\b/i],
  ["Vinyl & Music", /\b(vinyl|\blp\b|record|album|flute|orchestra|bill cosby)\b/i],
  ["Toys & Collectibles", /\b(star wars|hot wheels|power rangers?|red ranger|hasbro|action figure|lego|gundam|ban dai|bandai|beanie|puzzles?|robo alive|zuru|optimus|bumblebee|indiana jones|mighty morphin|toy biz|jakks|spin master|wwe|costume|dc comics|chess|checkers|signed|sign tank|sampras|agassi|favre)\b/i],
  ["Seasonal & Holiday", /\b(christmas|holiday living|\bc9\b|ornaments?|advent|hand warmers?|heated vests?|32\s*\*|32 heat|string lights)\b/i],
  ["Health & Personal Care", /\b(hair dryers?|ionic ceramic dryer|digital dryer|toothpaste|toothbrush|sonicare|deodorant|\bdove\b|sunscreen|\bspf\s?\d+|collagen|softgels?|dietary|beets|massagers?|glass scale|weight ?watchers|reading glasses|insoles?|trimmers?|micellar|facial|nitrile|exam gloves|jolie|showerhead|neck fan|\bd3\b|vitamins?|halo illumi\w*)\b/i],
  ["Bath & Fixtures", /\b(faucets?|showers?|shower heads?|toilets?|toilet seats?|bathroom mirrors?|mirror cabinets?|hyrdorail|hydroail|kohler assert)\b/i],
  ["Kitchen & Small Appliances", /\b(crockpots?|toasters?|coffee (?:makers?|machines?|centers?)|waffles?|air fryers?|griddles?|griddlers?|ice makers?|rice (?:cookers?|makers?)|food savers?|vacuum seals?|vacuum sealing|brauns?|multiquick|popcorns?|choppers?|brew controls?|pod coffees?|\bbrio\b|gourmias?|bella griddles?|skillets? with temp)\b/i],
  ["Home & Organization", /\b(sump pumps?|jet pumps?)\b/i],
  ["Kitchen & Dining", /\b(flatware|cutlery|knife sets?|pyrex|stoneware|bowls?|plate sets?|decanters?|cast iron|paellas?|iron skillets?|meal prep|lunch|bentgos?|arctic zones?|titan pros?|food jars?|thermoflasks?|coffee mugs?|sandwhich plates?|sandwich plates?)\b/i],
  ["Electronics & Lighting", /\b(night lights?|led strips?|strip lights?|light bulbs?|batter(?:y|ies)|flashlights?|recessed lights?|sconces?|smart leds?|lanterns?|lumens?|duracell)\b/i],
  ["Outdoor, Sports & Travel", /\b(solars?|trekking|swim goggles?|pickleballs?|address lights?|bug repell\w*|suitcases?|backpacks?|running gloves?|teak benchs?|teak benches|coolers?|40 cans?)\b/i],
  ["Home & Organization", /\b(rugs?|runners?|curtains?|vases?|trash|hangers?|organizers?|organizing|\bbins?\b|humidifiers?|air filters?|filtrete|furnace|britas?|water filters?|fans?\b|lasko|super fans?|wagners?|flexios?|blue air|air purifiers?|sump pumps?|jet pumps?|garment steam\w*|extremesteam|iron\/steam\w*|iron steam\w*|rowentas?|rowents?|scrubbers?|prep and serve|step trash|blackout)\b/i],
];

function decodeText(value) {
  let text = String(value || "");
  for (let i = 0; i < 3; i += 1) {
    const next = text
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">");
    if (next === text) break;
    text = next;
  }
  return text.replace(/\s+/g, " ").trim();
}

export function isMajorAppliance(text) {
  const value = decodeText(text).toLowerCase();
  if (/hair dryer|garment|countertop|toaster oven|air fryer|pizza oven|microwave/.test(value)) return false;
  return /\b(refrigerators?|fridges?|freezers?|dishwashers?|washing machines?|clothes dryers?|washers?|ranges?|wall ovens?|cooktops?|over[- ]the[- ]range)\b/.test(value);
}

export function classifyEbayStoreCategory({ title, category, priceCents } = {}) {
  const text = decodeText(`${title || ""} ${category || ""}`);
  let primary = null;
  if (isMajorAppliance(text)) primary = "Major Appliances (Pickup)";
  if (!primary) {
    for (const [name, pattern] of RULES) {
      if (pattern.test(text)) {
        primary = name;
        break;
      }
    }
  }
  const cents = Number(priceCents);
  const secondary = primary && primary !== UNDER_25 && Number.isFinite(cents) && cents > 0 && cents < 2500
    ? UNDER_25
    : null;
  return { primary, secondary };
}

export function storeCategoryNames(classified) {
  return [classified?.primary, classified?.secondary].filter(Boolean);
}

export function assertStoreCategoryNames(names = STORE_CATEGORY_ORDER) {
  for (const name of names) {
    if (!name || name.length > 30) {
      throw new Error(`eBay store category name must be 1-30 characters: ${name}`);
    }
  }
}
