/** Pure migration eligibility helpers (no network / no server imports). */
import { prohibitedReason } from "./ebay-eligibility.mjs";
import { NOT_APPLICABLE } from "./ebay-product.mjs";

export const MIGRATION_SKIP_KEYWORDS = [
  "refrigerator",
  "fridge",
  "freezer",
  "dishwasher",
  "mattress",
  "box spring",
  "boxspring",
];

/** eBay Trading title hard limit. */
export const MIGRATION_TITLE_MAX = 80;

/** Default package weight (lb) when Floor / source has none — calculated shipping requires it. */
export const MIGRATION_DEFAULT_WEIGHT_LB = 1;

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

/** Listing was actually removed for a policy hit (not just account-verification hide). */
export function isListingRemovedPolicyError(message) {
  const text = String(message || "");
  return /listing\s+has\s+been\s+removed\s+for\s+a\s+policy\s+violation/i.test(text);
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

/** Clip listing title to eBay's 80-character limit. */
export function clipMigrationTitle(title) {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (raw.length <= MIGRATION_TITLE_MAX) return raw;
  return `${raw.slice(0, MIGRATION_TITLE_MAX - 3).trimEnd()}...`;
}

/** Coerce Trading ConditionID to digits; default Used (3000). */
export function migrationConditionId(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length >= 3 && digits.length <= 5) return digits;
  return "3000";
}

/** Alternate ConditionIDs to try when AddFixedPriceItem rejects the primary. */
export function migrationConditionFallbacks(primary) {
  const first = migrationConditionId(primary);
  const alts = [first, "1000", "1500", "3000", "4000", "5000", "6000", "7000"];
  return [...new Set(alts)];
}

function aspectValues(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? "").trim()).filter(Boolean);
  if (value == null) return [];
  const s = String(value).trim();
  return s ? [s] : [];
}

function looksLikeBadMpn(value) {
  const v = String(value || "").trim();
  if (!v) return true;
  if (/^does\s+not\s+apply$/i.test(v)) return false;
  if (v.length > 40) return true;
  if (v.split(/\s+/).length > 4) return true;
  if (/sealed|complete\s+set|official\s+complete|trading\s+card/i.test(v)) return true;
  return false;
}

/**
 * Normalize item specifics for AddFixedPriceItem: drop bogus MPN, fill Brand/Model/Type
 * from Floor when missing (required aspects otherwise fail create after EndItem).
 */
export function sanitizeMigrationAspects(aspects, unit = null, item = null) {
  const out = {};
  for (const [name, value] of Object.entries(aspects || {})) {
    const vals = aspectValues(value);
    if (!vals.length) continue;
    if (/^mpn$/i.test(name) && looksLikeBadMpn(vals[0])) continue;
    out[name] = vals;
  }
  const brand = String(unit?.brand || out.Brand?.[0] || "").trim();
  if (brand && !/^(?:unknown|n\/?a)$/i.test(brand)) out.Brand = [brand];
  else if (!out.Brand?.[0]) out.Brand = [NOT_APPLICABLE];

  const model = String(unit?.model || out.Model?.[0] || "").trim();
  if (model && !looksLikeBadMpn(model)) out.Model = [model];
  else if (!out.Model?.[0]) out.Model = [NOT_APPLICABLE];

  if (!out.Type?.[0]) {
    const cat = String(item?.categoryName || unit?.category || "").trim();
    const leaf = cat.split(/>/).pop()?.trim() || "";
    out.Type = [leaf || NOT_APPLICABLE];
  }

  if (out.MPN && looksLikeBadMpn(out.MPN[0])) delete out.MPN;
  if (!out.MPN?.[0]) out.MPN = [NOT_APPLICABLE];

  return out;
}

/** Package weight for calculated-shipping create (always ≥ 1 lb). */
export function migrationWeightLb(unit = null, item = null) {
  const fromUnit = Number(unit?.package_weight_lb);
  const fromItem = Number(item?.weightLb);
  if (Number.isFinite(fromUnit) && fromUnit > 0) return fromUnit;
  if (Number.isFinite(fromItem) && fromItem > 0) return fromItem;
  return MIGRATION_DEFAULT_WEIGHT_LB;
}

/** EndItem already succeeded on a prior attempt (or Seller Hub ended it). */
export function isEndAlreadyEndedError(message) {
  const text = String(message || "");
  return /already\s+(been\s+)?ended|has\s+already\s+ended|ended\s+by\s+the\s+seller|item\s+cannot\s+be\s+accessed|not\s+found|invalid\s+item|auction\s+has\s+(already\s+)?been\s+closed/i.test(
    text,
  );
}

/** Source listing is no longer Active — still recreate on dest during live resume. */
export function isSourceAlreadyEndedStatus(blockedReason) {
  return /^listing_status_(completed|ended|closed)/i.test(String(blockedReason || ""));
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
