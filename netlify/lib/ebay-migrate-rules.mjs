/** Pure migration eligibility helpers (no network / no server imports). */
import { prohibitedReason } from "./ebay-eligibility.mjs";

export const MIGRATION_SKIP_KEYWORDS = [
  "refrigerator",
  "fridge",
  "freezer",
  "dishwasher",
  "mattress",
  "box spring",
  "boxspring",
];

function textBlob(item) {
  return [item?.title, item?.categoryName, item?.sku, item?.conditionDisplayName, ...(Object.values(item?.aspects || {}).flat())]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function migrationBannedReason(item, unit = null) {
  const banned = prohibitedReason(unit || { title: item?.title, category: item?.categoryName });
  if (banned) return `eBay terms / prohibited (${banned})`;
  const text = textBlob(item);
  for (const word of MIGRATION_SKIP_KEYWORDS) {
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (new RegExp(`(?:^|[^a-z0-9])${esc}(?:$|[^a-z0-9])`, "i").test(text)) {
      return `Skipped category/keyword: ${word}`;
    }
  }
  if (unit) {
    const cat = String(unit.category || "").toLowerCase();
    if (/refrigerat|fridge|dishwasher|mattress/.test(cat)) {
      return `Floor category blocked: ${unit.category}`;
    }
  }
  return null;
}

export function describeMigrationPlan() {
  return {
    steps: [
      "Connect business eBay account as role=selling (full listing scopes).",
      "Create business policies: Calculated Shipping – Buyer Pays, No Returns, Payment.",
      "Keep pgg124-5 connected as role=orders_only until its open orders finish shipping.",
      "Dry-run: list every ActiveList item from source via GetMyeBaySelling + GetItem; mark will_move / skipped.",
      "Live: for each will_move item — EndItem on source, AddFixedPriceItem on dest with same title/photos/description/specifics/condition/price, confirm Active, update listings.ebay_account_id + listing_id.",
      "Pace 4–9s between live moves. Never cancel/refund. Skip open orders, bids, best offers, refrigerators/dishwashers/mattresses, prohibited goods.",
      "After cutover: new listings + auto-delist use selling account; ebay-sync polls every connected account for sales/fees.",
    ],
    skipRules: [
      ...MIGRATION_SKIP_KEYWORDS.map((k) => `keyword/category: ${k}`),
      "open order on source",
      "active bids",
      "active best offer",
      "fully/partial sold quantity",
      "no photos / incomplete data",
      "eBay-prohibited goods (alcohol, tobacco, firearms, …)",
    ],
  };
}
