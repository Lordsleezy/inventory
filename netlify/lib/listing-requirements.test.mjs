import test from "node:test";
import assert from "node:assert/strict";
import { brandProblem, channelGaps, missingRequiredAspects } from "./listing-requirements.mjs";

const ready = {
  brand: "Bella",
  category: "Slow cookers",
  condition: "Open box",
  ask_cents: 2499,
  upc: "012345678905",
  package_weight_lb: 8,
  package_length_in: 16,
  package_width_in: 12,
  package_height_in: 10,
};

test("a complete unit can be pushed to eBay", () => {
  const result = channelGaps(ready, { channel: "ebay", photoCount: 2 });
  assert.equal(result.ready, true);
  assert.equal(result.reason, null);
});

test("eBay does not require a UPC", () => {
  const result = channelGaps({ ...ready, upc: "" }, { channel: "ebay", photoCount: 2 });
  assert.equal(result.ready, true);
  assert.equal(result.reason, null);
});

test("Amazon and TikTok still require a UPC", () => {
  const noUpc = { ...ready, upc: "" };
  const amazon = channelGaps(noUpc, { channel: "amazon", photoCount: 2 });
  const tiktok = channelGaps(noUpc, { channel: "tiktok", photoCount: 2 });
  assert.equal(amazon.ready, false);
  assert.match(amazon.reason, /UPC/);
  assert.equal(tiktok.ready, false);
  assert.match(tiktok.reason, /UPC/);
});

test("missing brand and weight are named, and Generic is not a brand", () => {
  assert.equal(brandProblem("Generic"), "invalid");
  assert.equal(brandProblem("Unbranded"), null);
  const result = channelGaps({ ...ready, brand: "", package_weight_lb: null }, { channel: "ebay", photoCount: 1 });
  assert.equal(result.ready, false);
  assert.match(result.reason, /Needs: brand, weight/);
  assert.equal(result.section, "missing-brand");
});

test("Amazon catalog block stays even when the other fields are filled", () => {
  const result = channelGaps(ready, {
    channel: "amazon",
    photoCount: 1,
    amazonBlocked: "Not on Amazon — UPC/brand GS1 mismatch",
  });
  assert.equal(result.ready, false);
  assert.match(result.reason, /Amazon catalog/);
});

test("required eBay aspects besides brand come from the stored definitions", () => {
  const missing = missingRequiredAspects({}, [
    { name: "Brand", required: true },
    { name: "Type", required: true },
    { name: "Color", required: false },
  ]);
  assert.deepEqual(missing, ["Type"]);
  const result = channelGaps(ready, {
    channel: "ebay",
    photoCount: 1,
    aspectDefs: [{ name: "Type", required: true }],
  });
  assert.match(result.reason, /Type/);
});
