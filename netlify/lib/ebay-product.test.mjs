import assert from "node:assert/strict";
import { test } from "node:test";
import { draftReadiness } from "./ebay-price.mjs";
import { ebayDescription, ebayIdentifiers } from "./ebay-product.mjs";

test("draft Brand and MPN reach the Inventory API identifiers", () => {
  assert.deepEqual(ebayIdentifiers({ brand: "Old brand", model: "" }, { Brand: "Colgate", MPN: "Does Not Apply" }), {
    brand: "Colgate", mpn: "Does not apply", upc: "Does not apply", validBrand: true,
  });
  assert.equal(ebayIdentifiers({}, {}).validBrand, false);
});

test("eBay copy drops Floor footer and ends with bare SKU", () => {
  const old = "Product features.\n\nThis unit (Floor):\nCondition: New\nSKU 99105\nSold as-is. Local pickup unless arranged.";
  assert.equal(ebayDescription(old, "99105"), "Product features.\n\n99105");
  assert.equal(ebayDescription(ebayDescription(old, "99105"), "99105"), "Product features.\n\n99105");
});

test("a draft without a brand is blocked before push", () => {
  const draft = {
    photo_paths: ["photo"], title: "Product", description: "Features", category_id: "67422",
    condition_id: "1000", box: { length_in: 1, width_in: 1, height_in: 1, weight_lb: 1 },
    price_cents: 1000, shipping_mode: "free", aspect_defs: [{ name: "Brand", required: true, allowed: [], selectionOnly: false }],
    aspects: {},
  };
  const check = draftReadiness(draft);
  assert.equal(check.ready, false);
  assert.ok(check.items.some((item) => item.label === "Brand needed" && !item.ok));
  draft.unit_brand = "Colgate";
  assert.equal(draftReadiness(draft).ready, true);
});
