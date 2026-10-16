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

/** eBay GetItem error when the seller account is under verification (listings hidden, not a real policy hit). */
export function isVerificationHiddenListingError(message) {
  const text = String(message || "");
  return (
    /policy\s+violation/i.test(text) &&
    /hidden\s+until\s+you\s+can\s+fix/i.test(text)
  );
}

export function migrationBannedReason(item, unit = null) {
  const banned = prohibitedReason(unit || { title: item?.title, category: item?.categoryName });
  if (banned) return `eBay terms / prohibited (${banned})`;
  // Prefer Floor title/category when matched so a bad eBay category (e.g. jersey misfiled as fridge) does not skip.
  const text = textBlob(
    unit
      ? {
          title: unit.title || item?.title,
          categoryName: unit.category || item?.categoryName,
          sku: unit.sku || item?.sku,
          conditionDisplayName: unit.condition || item?.conditionDisplayName,
          aspects: item?.aspects,
        }
      : item,
  );
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

/** Build a Trading-shaped item from GetMyeBaySelling ActiveList when GetItem is blocked. */
export function itemFromActiveListSummary(row) {
  return {
    itemId: String(row.itemId),
    title: row.title || "",
    description: row.title || "",
    sku: row.sku || "",
    categoryId: row.categoryId || "",
    categoryName: row.categoryName || "",
    conditionId: "3000",
    conditionDisplayName: "",
    conditionDescription: "",
    price: row.currentPrice || "0",
    currency: "USD",
    quantity: Number(row.quantity || 0),
    quantitySold: Number(row.quantitySold || 0),
    bidCount: Number(row.bidCount || 0),
    listingStatus: row.listingStatus || "Active",
    listingType: row.listingType || "FixedPriceItem",
    bestOfferCount: 0,
    bestOfferEnabled: false,
    imageUrls: Array.isArray(row.imageUrls) ? row.imageUrls.filter(Boolean) : [],
    aspects: {},
    location: "",
    postalCode: "",
    country: "US",
    dispatchTimeMax: 2,
    viewItemUrl: row.viewItemUrl || "",
    verificationHidden: true,
  };
}

export function emptyMigrationSummary() {
  return { moved: 0, skipped: 0, failed: 0, will_move: 0, total: 0 };
}

export function tallyMigrationSummary(items) {
  const summary = emptyMigrationSummary();
  for (const row of items || []) {
    summary.total += 1;
    const outcome = String(row.outcome || "");
    if (outcome === "moved") summary.moved += 1;
    else if (outcome === "skipped") summary.skipped += 1;
    else if (outcome === "failed") summary.failed += 1;
    else if (outcome === "will_move") summary.will_move += 1;
  }
  return summary;
}

export function describeMigrationPlan() {
  return {
    steps: [
      "Connect business eBay account as role=selling (full listing scopes).",
      "Create business policies: Calculated Shipping – Buyer Pays, No Returns, Payment.",
      "Keep pgg124-5 connected as role=orders_only until its open orders finish shipping.",
      "Dry-run: discover every source listing via GetMyeBaySelling ActiveList (all pages) + GetSellerList + Floor listings.ebay, then GetItem; mark will_move / skipped. Account-verification hides count as will_move, not failed.",
      "Live: for each will_move item — EndItem on source, AddFixedPriceItem on dest with same title/photos/description/specifics/condition/price (Floor enrichment when GetItem is blocked by verification), confirm Active, update listings.ebay_account_id + listing_id.",
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
