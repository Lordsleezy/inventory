/**
 * What a buyer should be charged for USPS from Penryn, using Floor's box
 * and the November 2026 commercial rate card. Never raises a live price.
 */
import gaRates from "./usps-ga-2026.json" with { type: "json" };
import pmRates from "./usps-pm-2026.json" with { type: "json" };
import zoneChart from "./usps-zone-956.json" with { type: "json" };

export const ORIGIN_ZIP = "95663";
export const PRICE_ZONE = 6;
export const PRICE_ZIP = "73101";
export const FEE_RATE = 0.149;
export const MIN_CHARGE = 6;
export const FINE_GAP = 1.5;
export const FLAT_TIER_MIN = 10;
export const FLAT_TIER_MAX = 12.5;
export const FLAT_TIER_GAP = 4;
export const DIM_DIVISOR = 166;
export const CUBIC_FOOT = 1728;
export const TWO_CUBIC_FEET = 3456;

export function zoneFromZip(postal, ranges = zoneChart.ranges) {
  const digits = String(postal || "").replace(/\D/g, "");
  if (digits.length < 3) return null;
  const zip3 = Number(digits.slice(0, 3));
  if (!Number.isFinite(zip3)) return null;
  for (const [start, end, zone] of ranges) {
    if (zip3 >= start && zip3 <= end) return zone;
  }
  return null;
}

export function zonePercentile(zones, percentile) {
  const clean = zones.filter((z) => Number.isFinite(z)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil(clean.length * percentile) - 1));
  return clean[index];
}

function rateAt(table, pounds, zone) {
  const row = table[String(pounds)] || table[pounds];
  if (!row) return null;
  const value = row[zone - 1];
  return Number.isFinite(value) ? value : null;
}

export function groundAdvantagePostage(pounds, zone) {
  if (!(pounds > 0) || zone < 1 || zone > 8) return null;
  if (pounds < 1) {
    const oz = Math.max(1, pounds * 16);
    const key = oz <= 4 ? 4 : oz <= 8 ? 8 : oz <= 12 ? 12 : 16;
    return rateAt(gaRates.ounces, key, zone);
  }
  return rateAt(gaRates.pounds, Math.min(70, Math.ceil(pounds)), zone);
}

export function priorityPostage(pounds, zone) {
  if (!(pounds > 0) || zone < 1 || zone > 8) return null;
  const lb = Math.min(70, Math.max(1, Math.ceil(pounds)));
  return rateAt(pmRates.pounds, lb, zone);
}

export function packageChangeLowers(fromBox, toBox) {
  const from = billablePounds(fromBox);
  const to = billablePounds(toBox);
  if (!from || !to) return false;
  return to.pounds < from.pounds - 0.05;
}

export function billablePounds({ lengthIn, widthIn, heightIn, weightLb }) {
  const sides = [lengthIn, widthIn, heightIn].map(Number);
  const weight = Number(weightLb);
  if (sides.some((n) => !(n > 0)) || !(weight > 0)) return null;
  const cubic = sides[0] * sides[1] * sides[2];
  const dim = cubic > CUBIC_FOOT ? cubic / DIM_DIVISOR : 0;
  return { pounds: Math.max(weight, dim), cubic, longest: Math.max(...sides) };
}

/** USPS commercial Ground Advantage, including the length and volume fees on the 2026 card. */
export function labelCostDollars(box, zone = PRICE_ZONE) {
  const bill = billablePounds(box);
  if (!bill) return null;
  const postage = groundAdvantagePostage(bill.pounds, zone);
  const priority = priorityPostage(Math.max(bill.pounds, 0.5), zone);
  if (postage == null) return null;
  let extra = 0;
  if (bill.longest > 30) extra += 10;
  else if (bill.longest > 22) extra += 4.5;
  if (bill.cubic > TWO_CUBIC_FEET) extra += 21;
  return {
    pounds: bill.pounds,
    cubic: bill.cubic,
    longest: bill.longest,
    ground: roundCents(postage + extra),
    priority: priority == null ? null : roundCents(priority + extra),
  };
}

export function roundCents(dollars) {
  return Math.round(dollars * 100) / 100;
}

export function roundUpHalfDollar(dollars) {
  return Math.ceil((dollars - 1e-9) * 2) / 2;
}

/** Buyer charge that still covers the label after eBay's fee. Never below the $6 floor. */
export function shouldBeCharge(labelDollars, feeRate = FEE_RATE) {
  if (!(labelDollars > 0)) return null;
  const whole = labelDollars / (1 - feeRate);
  return roundUpHalfDollar(Math.max(MIN_CHARGE, whole));
}

/** Compare a listing to the service it actually offers. Priority-only is not judged against Ground Advantage. */
export function comparedShipping({ ground, priority, groundShould, priorityShould }) {
  if (ground != null) return { service: "Ground Advantage", current: ground, shouldBe: groundShould };
  if (priority != null) return { service: "Priority Mail", current: priority, shouldBe: priorityShould };
  return { service: "", current: null, shouldBe: null };
}

export function classifyListing({ currentCheapest, shouldBe, missing }) {
  if (missing || shouldBe == null || currentCheapest == null || !(currentCheapest >= 0)) return "cant_tell";
  const gap = roundCents(currentCheapest - shouldBe);
  const tier = currentCheapest >= FLAT_TIER_MIN && currentCheapest <= FLAT_TIER_MAX;
  const highBar = tier ? FLAT_TIER_GAP : FINE_GAP;
  if (gap > highBar) return "too_high";
  if (gap < -FINE_GAP) return "too_low";
  return "fine";
}

/** The amount to publish. Too-low and fine listings stay put. A lower amount is never raised. */
export function chargeToPublish(currentCheapest, shouldBe, verdict) {
  if (verdict !== "too_high" || shouldBe == null || currentCheapest == null) return null;
  const next = Math.min(currentCheapest, shouldBe);
  if (!(next < currentCheapest - 0.009)) return null;
  return roundCents(next);
}

export function priorityBeside(groundCharge, groundPostage, priorityPostageAmount) {
  if (!(groundCharge > 0) || !(priorityPostageAmount > groundPostage)) return roundUpHalfDollar(groundCharge + 0.5);
  const delta = (priorityPostageAmount - groundPostage) / (1 - FEE_RATE);
  return roundUpHalfDollar(groundCharge + delta);
}

export function buildFlatShippingPolicy({
  name,
  handlingTime,
  groundDollars,
  priorityDollars,
  localPickup = false,
  international = [],
}) {
  const domestic = {
    optionType: "DOMESTIC",
    costType: "FLAT_RATE",
    shippingServices: [
      flatService("USPSParcel", 1, groundDollars),
      flatService("USPSPriority", 2, priorityDollars),
    ],
  };
  return {
    name,
    marketplaceId: "EBAY_US",
    categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES", default: true }],
    handlingTime,
    localPickup: Boolean(localPickup),
    freightShipping: false,
    shippingOptions: [domestic, ...international],
  };
}

function flatService(code, sortOrder, dollars) {
  const value = Number(dollars).toFixed(2);
  return {
    sortOrder,
    shippingCarrierCode: "USPS",
    shippingServiceCode: code,
    freeShipping: false,
    shippingCost: { value, currency: "USD" },
    additionalShippingCost: { value, currency: "USD" },
    buyerResponsibleForShipping: false,
  };
}

/** Fields a shipping-only revise is allowed to send. Price and title are absent on purpose. */
export function shippingReviseChange(row) {
  return {
    itemId: String(row.listingId),
    fulfillmentPolicyId: String(row.fulfillmentPolicyId),
    paymentPolicyId: String(row.paymentPolicyId),
    returnPolicyId: String(row.returnPolicyId),
  };
}

export function rollbackRows(changes) {
  return (changes || []).map((row) => ({
    listingId: String(row.listingId),
    sku: row.sku || "",
    fulfillmentPolicyId: String(row.fromPolicyId || ""),
    paymentPolicyId: String(row.paymentPolicyId || ""),
    returnPolicyId: String(row.returnPolicyId || ""),
  })).filter((row) => row.listingId && row.fulfillmentPolicyId);
}
