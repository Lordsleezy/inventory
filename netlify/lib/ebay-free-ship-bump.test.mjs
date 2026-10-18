import assert from "node:assert/strict";
import { selectEligibleFromAuditRows, SHIP_CUTOFF_CENTS, PRICE_BUMP_CENTS } from "./ebay-free-ship-bump.mjs";

const { eligible, skipped } = selectEligibleFromAuditRows([
  {
    floor_sku: "11168",
    ebay_item_id: "1",
    shipping_mode: "calculated",
    shippo_estimate_cents: "978",
    ebay_price_cents: "8099",
    retail_high_cents: "",
    dims_missing: "no",
    product_name: "suitcase",
  },
  {
    floor_sku: "99901",
    ebay_item_id: "2",
    shipping_mode: "calculated",
    shippo_estimate_cents: "1500",
    ebay_price_cents: "2000",
    dims_missing: "no",
  },
  {
    floor_sku: "99902",
    ebay_item_id: "3",
    shipping_mode: "free",
    shippo_estimate_cents: "0",
    ebay_price_cents: "2000",
    dims_missing: "no",
  },
  {
    floor_sku: "11216",
    ebay_item_id: "4",
    shipping_mode: "calculated",
    shippo_estimate_cents: "978",
    ebay_price_cents: "4499",
    retail_high_cents: "2500",
    dims_missing: "no",
    product_name: "ranger",
  },
]);

assert.equal(SHIP_CUTOFF_CENTS, 1000);
assert.equal(PRICE_BUMP_CENTS, 1000);
assert.equal(eligible.length, 2);
assert.equal(eligible[0].sku, "11168");
assert.equal(eligible[0].new_ebay_cents, 9099);
assert.equal(eligible[0].over_retail_after, false);
assert.equal(eligible[1].sku, "11216");
assert.equal(eligible[1].new_ebay_cents, 5499);
assert.equal(eligible[1].over_retail_after, true);
assert.ok(skipped.some((s) => s.reason === "ship_over_cutoff"));
assert.ok(skipped.some((s) => s.reason === "already_free"));

console.log("ebay-free-ship-bump.test.mjs ok");
