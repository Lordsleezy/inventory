import assert from "node:assert/strict";
import { clipEbayTitle, ebayListingTitle, stripSkuAndConditionFromTitle } from "./ebay-title.mjs";

assert.equal(
  stripSkuAndConditionFromTitle("Artika Bowen Solar LED Address Wall Light — open_box | SKU 11434"),
  "Artika Bowen Solar LED Address Wall Light",
);
assert.equal(
  stripSkuAndConditionFromTitle("Kohler 2.1-Gallon Stainless Steel Step Trash Can Open Box | SKU 99736"),
  "Kohler 2.1-Gallon Stainless Steel Step Trash Can",
);
assert.equal(
  stripSkuAndConditionFromTitle("Bella Crockpot Open box Unused"),
  "Bella Crockpot",
);
assert.equal(
  stripSkuAndConditionFromTitle("Lifelines Wild Mint & Lavender — Used - Good — Diffusers | SKU 99861"),
  "Lifelines Wild Mint & Lavender",
);
assert.equal(
  ebayListingTitle({
    brand: "Philips",
    model: "Norelco Shaver 9000",
    title: "Philips Norelco Shaver 9000",
    condition: "Open box",
    sku: "11997",
  }),
  "Philips Norelco Shaver 9000",
);
assert.equal(
  ebayListingTitle({ ebay_title: "Custom Title — New | SKU 1", sku: "1", condition: "New" }),
  "Custom Title",
);
assert.ok(clipEbayTitle("x".repeat(100)).length <= 80);

console.log("ebay-title.test.mjs ok");
