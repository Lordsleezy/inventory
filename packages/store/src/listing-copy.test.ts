import assert from "node:assert/strict";
import test from "node:test";
import { composeChannelDescription, listingWeightLb, needsShipWeight, regenerateListingBody } from "./listing-copy.ts";

test("channel copy always keeps Floor defect notes", () => {
  const text = composeChannelDescription({
    listingBody: "A 20.5 cu ft top freezer.",
    condition: "Good",
    testStatus: "passed",
    defectNotes: "Dent on door",
    sku: "11116",
  });
  assert.match(text, /A 20.5 cu ft top freezer/);
  assert.match(text, /Condition: Good/);
  assert.match(text, /Dent on door/);
  assert.match(text, /SKU 11116/);
});

test("regenerate uses specs without touching defects", () => {
  const body = regenerateListingBody({
    brand: "Midea",
    model: "MRT21D3BST",
    specs: {
      matched_model: "MRT21D3BST",
      configuration: "Top-freezer refrigerator",
      capacity_cu_ft: 20.5,
      fridge_cu_ft: 14.7,
      freezer_cu_ft: 5.8,
      width_in: '29.7"',
      height_in: '66.6"',
      depth_in: '32.7"',
      finish: "Stainless steel",
    },
  });
  assert.match(body, /Midea MRT21D3BST/);
  assert.match(body, /20.5 cu ft/);
  assert.doesNotMatch(body, /Condition/);
});

test("shippable units without weight are flagged", () => {
  assert.equal(listingWeightLb({ weight_lb: "12.5" }), 12.5);
  assert.equal(listingWeightLb({ weight_lb: "" }), null);
  assert.equal(needsShipWeight({ shippable: true, listingSpecs: {} }), true);
  assert.equal(needsShipWeight({ shippable: true, listingSpecs: { weight_lb: "8" } }), false);
  assert.equal(needsShipWeight({ shippable: false, listingSpecs: {} }), false);
});
