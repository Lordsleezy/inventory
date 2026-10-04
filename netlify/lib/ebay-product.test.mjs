import assert from "node:assert/strict";
import { test } from "node:test";
import { draftReadiness } from "./ebay-price.mjs";
import { ebayDescription, ebayIdentifiers } from "./ebay-product.mjs";
import { gtinIssue } from "./gtin.mjs";

test("draft Brand and MPN reach the Inventory API identifiers", () => {
  assert.deepEqual(ebayIdentifiers({ brand: "Old brand", model: "" }, { Brand: "Colgate", MPN: "Does Not Apply" }), {
    brand: "Colgate", mpn: "Does not apply", upc: null, upcIssue: null, validBrand: true,
  });
  assert.equal(ebayIdentifiers({}, {}).validBrand, false);
});

test("UPC-A, EAN-13, and GTIN-14 require valid check digits", () => {
  assert.equal(gtinIssue("075020108296"), null);
  assert.equal(gtinIssue("887063466175"), "bad check digit");
  assert.equal(gtinIssue("887063466178"), null);
  assert.equal(gtinIssue("4006381333931"), null);
  assert.equal(gtinIssue("00012345600012"), null);
  assert.equal(gtinIssue("123456789"), "must have 12, 13, or 14 digits");
  assert.equal(ebayIdentifiers({ upc: "887063466175" }).upc, null);
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

test("a category without an eBay condition policy can still pass readiness", () => {
  const draft = {
    photo_paths: ["photo"], title: "Signed tennis memorabilia", description: "Signed collectible",
    category_id: "1226", condition_id: null, condition_not_supported: true,
    box: { length_in: 10, width_in: 10, height_in: 2, weight_lb: 2 },
    price_cents: 3999, shipping_mode: "calculated", unit_brand: "Andre Agassi",
    aspect_defs: [{ name: "Brand", required: true, allowed: [], selectionOnly: false }],
    aspects: { MPN: "Does not apply" },
  };
  assert.equal(draftReadiness(draft).ready, true);
  draft.condition_not_supported = false;
  assert.equal(draftReadiness(draft).ready, false);
});
