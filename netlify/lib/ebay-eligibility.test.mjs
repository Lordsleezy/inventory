import assert from "node:assert/strict";
import test from "node:test";
import { ebayDraftEligibility, prohibitedReason } from "./ebay-eligibility.mjs";

const rules = {
  excludedCategories: ["Refrigerator", "Freezer", "Mattresses", "Dishwasher", "Washer", "Dryer", "Range", "Oven", "Living room furniture", "Furniture"],
  excludedKeywords: ["refrigerator", "fridge", "freezer", "mattress", "box spring", "dishwasher", "washing machine", "sofa", "sectional", "couch", "recliner"],
  maxWeightLb: 70,
  maxLengthIn: 108,
  maxGirthIn: 165,
};

const base = {
  state: "available",
  ask_cents: 4000,
  photo_count: 1,
  title: "Desk lamp",
  brand: "GE",
  model: "123",
  category: "Lighting",
  package_length_in: 12,
  package_width_in: 8,
  package_height_in: 6,
  package_weight_lb: 4,
};

test("a normal unit with a photo and a price is eligible", () => {
  assert.equal(ebayDraftEligibility(base, rules).ok, true);
});

test("missing box size still drafts", () => {
  const row = ebayDraftEligibility({ ...base, package_weight_lb: null, package_length_in: null }, rules);
  assert.equal(row.ok, true);
  assert.equal(row.needsBox, true);
});

test("website shipping exclusions stay off eBay", () => {
  assert.equal(ebayDraftEligibility({ ...base, category: "Refrigerator" }, rules).ok, false);
  assert.equal(ebayDraftEligibility({ ...base, title: "Leather sofa" }, rules).ok, false);
  assert.equal(ebayDraftEligibility({ ...base, package_weight_lb: 80 }, rules).ok, false);
  assert.equal(ebayDraftEligibility({ ...base, package_length_in: 120, package_width_in: 10, package_height_in: 10 }, rules).ok, false);
});

test("Truly hard seltzer is prohibited", () => {
  const unit = { ...base, sku: "11462", title: "Truly Hard Seltzer Variety 12 Pack", brand: "Truly", category: "Beverages" };
  assert.equal(prohibitedReason(unit), "hard seltzer");
  assert.match(ebayDraftEligibility(unit, rules).reason, /prohibits/i);
});
