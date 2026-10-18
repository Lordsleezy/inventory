import assert from "node:assert/strict";
import {
  selectEligibleFromAuditRows,
  selectCollectiblesToRevert,
  isCollectible,
  SHIP_CUTOFF_CENTS,
  PRICE_BUMP_CENTS,
} from "./ebay-free-ship-bump.mjs";

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

assert.equal(isCollectible({ title: "star wars y wing scout bomber" }), true);
assert.equal(isCollectible({ title: "bentgo chill max lunch box" }), false);
assert.equal(isCollectible({ title: "johnny cash vinyl record" }), true);
assert.equal(isCollectible({ categoryName: "Vinyl Records" }), true);

const revert = selectCollectiblesToRevert([
  { sku: "11216", item_id: "1", title: "power rangers figure", old_ebay_cents: "4499", new_ebay_cents: "5499", ok: "yes" },
  { sku: "11312", item_id: "2", title: "arctic zone lunch box", old_ebay_cents: "3899", new_ebay_cents: "4899", ok: "yes" },
  { sku: "11217", item_id: "3", title: "star wars y wing", old_ebay_cents: "2999", new_ebay_cents: "3999", ok: "no" },
]);
assert.equal(revert.length, 1);
assert.equal(revert[0].sku, "11216");
assert.equal(revert[0].restore_cents, 4499);

console.log("ebay-free-ship-bump.test.mjs ok");
