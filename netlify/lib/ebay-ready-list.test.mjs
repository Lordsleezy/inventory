import assert from "node:assert/strict";
import test from "node:test";
import {
  BUYER_PAYS_UNDER_CENTS,
  hikeAskCents,
  isOpenBox,
  openBoxUnusedTitle,
  planFloorHike,
  readyListPricePlan,
  OPEN_BOX_UNUSED_NOTE,
} from "./ebay-ready-list.mjs";

test("hikeAskCents is +10%", () => {
  assert.equal(hikeAskCents(2000), 2200);
  assert.equal(hikeAskCents(10000), 11000);
  assert.equal(hikeAskCents(2499), 2749);
});

test("planFloorHike only when under retail", () => {
  assert.deepEqual(planFloorHike({ askCents: 2000, retailCents: 5000 }), {
    ask_cents: 2200,
    hiked: true,
    retail_cents: 5000,
    hiked_would_be_cents: 2200,
  });
  assert.equal(planFloorHike({ askCents: 4800, retailCents: 5000 }).hiked, false);
  assert.equal(planFloorHike({ askCents: 2000, retailCents: null }).hiked, false);
});

test("readyListPricePlan forces calculated under $100", () => {
  const under = readyListPricePlan({ floorCents: 9999, labelCents: 500, retailCents: 20000 });
  assert.equal(under.mode, "calculated");
  assert.equal(under.under_100, true);
  assert.ok(under.price_cents > 0);

  const over = readyListPricePlan({ floorCents: 10000, labelCents: 500, retailCents: 50000 });
  assert.equal(over.mode, "free");
  assert.equal(over.under_100, false);
  assert.equal(BUYER_PAYS_UNDER_CENTS, 10000);
});

test("readyListPricePlan caps eBay price at retail", () => {
  const capped = readyListPricePlan({ floorCents: 7011, labelCents: 800, retailCents: 7499 });
  assert.equal(capped.mode, "calculated");
  assert.ok(capped.price_cents <= 7499);
});

test("open box unused title and detection", () => {
  const unit = { sku: "11701", brand: "Grüns", title: "Daily sachets", condition: "Open box" };
  assert.equal(isOpenBox(unit), true);
  const title = openBoxUnusedTitle(unit);
  assert.match(title, /Unused/i);
  assert.match(title, /Open Box/i);
  assert.match(title, /SKU 11701/);
  assert.ok(title.length <= 80);
  assert.match(OPEN_BOX_UNUSED_NOTE, /UNUSED/);
});
