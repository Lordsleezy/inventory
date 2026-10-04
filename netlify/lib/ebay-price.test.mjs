import assert from "node:assert/strict";
import test from "node:test";
import {
  draftReadiness,
  ebayFeeCents,
  ebayOrderAmounts,
  ebayPriceCents,
  fallbackLabelCents,
  roundUpEnding,
  shippingModeForLabel,
} from "./ebay-price.mjs";

const fee = { feePct: 13.25, perOrderCents: 40, ending: 99 };

test("rounds up to .99 and leaves an exact .99 alone", () => {
  assert.equal(roundUpEnding(4210, 99), 4299);
  assert.equal(roundUpEnding(4299, 99), 4299);
  assert.equal(roundUpEnding(4300, 99), 4399);
});

test("free shipping bakes the label; calculated shipping does not", () => {
  const free = ebayPriceCents({ floorCents: 10000, labelCents: 1200, mode: "free", ...fee });
  const calc = ebayPriceCents({ floorCents: 10000, labelCents: 2000, mode: "calculated", ...fee });
  // (10000+1200)/0.8675 + 40 = 12950.66 → 12999
  assert.equal(free, 12999);
  // 10000/0.8675 + 40 = 11567.38 → 11599
  assert.equal(calc, 11599);
  assert.equal(shippingModeForLabel(1200, 1500), "free");
  assert.equal(shippingModeForLabel(1500, 1500), "free");
  assert.equal(shippingModeForLabel(1501, 1500), "calculated");
});

test("shipping buffer affects only free-shipping price, not cutoff", () => {
  assert.equal(ebayPriceCents({ floorCents: 10000, labelCents: 1200, bufferCents: 200, mode: "free", ...fee }), 13199);
  assert.equal(ebayPriceCents({ floorCents: 10000, labelCents: 1200, bufferCents: 200, mode: "calculated", ...fee }), 11599);
  assert.equal(shippingModeForLabel(1500, 1500), "free");
});

test("eBay fee and order amounts use the item price, not buyer shipping", () => {
  assert.equal(ebayFeeCents(12999, 13.25, 40), Math.round(12999 * 0.1325) + 40);
  const amounts = ebayOrderAmounts({
    lineItems: [{ sku: "1", lineItemCost: { value: "129.99" }, total: { value: "129.99" } }],
    pricingSummary: { priceSubtotal: { value: "129.99" }, deliveryCost: { value: "0.00" }, total: { value: "129.99" } },
  });
  assert.equal(amounts.itemCents, 12999);
  assert.equal(amounts.shipCents, 0);
});

test("fallback label is under $15 for a small box and over for a heavy one", () => {
  assert.equal(fallbackLabelCents({ length_in: 12, width_in: 8, height_in: 4, weight_lb: 2 }) <= 1500, true);
  assert.equal(fallbackLabelCents({ length_in: 24, width_in: 18, height_in: 12, weight_lb: 25 }) > 1500, true);
});

test("push stays blocked until required fields pass", () => {
  const blocked = draftReadiness({ title: "Lamp", description: "", category_id: "", photo_paths: [], box: {}, aspects: {}, aspect_defs: [] });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.items.some((item) => item.label === "Needs box size"), true);
  const ready = draftReadiness({
    title: "Lamp",
    description: "Works.",
    category_id: "20706",
    condition_id: "3000",
    photo_paths: ["a.jpg"],
    box: { length_in: 10, width_in: 8, height_in: 6, weight_lb: 3 },
    price_cents: 2499,
    shipping_mode: "free",
    aspects: { Brand: "GE" },
    aspect_defs: [{ name: "Brand", required: true, allowed: [], selectionOnly: false }],
  });
  assert.equal(ready.ready, true);
});
