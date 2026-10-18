import assert from "node:assert/strict";
import { photoDayPricePlan, FEE_PCT } from "./ebay-photo-day-list.mjs";

assert.equal(FEE_PCT, 10);

const under = photoDayPricePlan({ floorCents: 2000, labelCents: 800, retailCents: 5000 });
assert.equal(under.mode, "free");
assert.equal(under.over_retail_if_free, false);
assert.ok(under.price_cents > 2000 + 800); // fee gross-up
assert.equal(under.price_cents % 100, 99);

const over = photoDayPricePlan({ floorCents: 4000, labelCents: 1500, retailCents: 4500 });
assert.equal(over.mode, "calculated");
assert.equal(over.over_retail_if_free, true);
assert.ok(over.free_would_be_cents > 4500);
assert.ok(over.price_cents < over.free_would_be_cents);

const noRetail = photoDayPricePlan({ floorCents: 2000, labelCents: 800, retailCents: null });
assert.equal(noRetail.mode, "free");

console.log("ebay-photo-day-list.test.mjs ok");
