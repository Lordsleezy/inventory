import assert from "node:assert/strict";
import test from "node:test";
import {
  STORE_CATEGORY_ORDER,
  UNDER_25,
  assertStoreCategoryNames,
  classifyEbayStoreCategory,
} from "./ebay-store-categories.mjs";

test("store category names fit eBay's 30 character limit", () => {
  assertStoreCategoryNames(STORE_CATEGORY_ORDER);
  assert.equal(new Set(STORE_CATEGORY_ORDER).size, STORE_CATEGORY_ORDER.length);
});

test("departments come from the title, and Under $25 is only a second category", () => {
  assert.deepEqual(
    classifyEbayStoreCategory({ title: "Bella Crockpot Open box Unused", priceCents: 4674 }),
    { primary: "Kitchen & Small Appliances", secondary: null },
  );
  assert.deepEqual(
    classifyEbayStoreCategory({ title: "Pokemon chaos rising blister pack", priceCents: 1999 }),
    { primary: "Trading Cards", secondary: UNDER_25 },
  );
  assert.equal(
    classifyEbayStoreCategory({ title: "the fabulous johnny cash lp vinyl", priceCents: 1999 }).primary,
    "Vinyl & Music",
  );
  assert.equal(
    classifyEbayStoreCategory({ title: "Conair Infiniti Pro 1875 Watt Hair Dryer", priceCents: 1999 }).primary,
    "Health & Personal Care",
  );
  assert.equal(
    classifyEbayStoreCategory({ title: "Holiday Living Clear C9 Indoor Outdoor Lights", priceCents: 1799 }).primary,
    "Seasonal & Holiday",
  );
  assert.equal(
    classifyEbayStoreCategory({ title: "motion activated solar security LED light", priceCents: 4249 }).primary,
    "Outdoor, Sports & Travel",
  );
  assert.equal(
    classifyEbayStoreCategory({ title: "GE French Door Refrigerator", priceCents: 40000 }).primary,
    "Major Appliances (Pickup)",
  );
  assert.equal(
    classifyEbayStoreCategory({ title: "Gourmia Countertop oven with air fryer", priceCents: 9199 }).primary,
    "Kitchen & Small Appliances",
  );
  assert.equal(classifyEbayStoreCategory({ title: "Fortessa flatware set", priceCents: 13049 }).secondary, null);
  assert.equal(classifyEbayStoreCategory({ title: "Fortessa flatware set", priceCents: 2499 }).secondary, UNDER_25);
  assert.equal(
    classifyEbayStoreCategory({ title: "Ridgid cast iron sump pump", priceCents: 21504 }).primary,
    "Home & Organization",
  );
  assert.equal(
    classifyEbayStoreCategory({ title: "thermoflask insulated coffee mug", priceCents: 2299 }).primary,
    "Kitchen & Dining",
  );
  assert.equal(
    classifyEbayStoreCategory({ title: "Dove Sensitive 16 bars", priceCents: 1999 }).primary,
    "Health & Personal Care",
  );
  assert.equal(
    classifyEbayStoreCategory({ title: "Conair Halo Illumiate mirror", priceCents: 3149 }).primary,
    "Health & Personal Care",
  );
});
