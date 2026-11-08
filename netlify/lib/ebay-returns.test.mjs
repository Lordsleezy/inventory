import assert from "node:assert/strict";
import test from "node:test";
import { deductionRefundCents, mapEbayReturn } from "./ebay-returns.mjs";

test("a deduction cannot pass half the item price", () => {
  assert.deepEqual(deductionRefundCents(2000, 10), { refundCents: 1800, deductedCents: 200, percent: 10 });
  assert.equal(deductionRefundCents(2000, 80).percent, 50);
  assert.equal(deductionRefundCents(2000, 80).refundCents, 1000);
});

test("change-of-mind maps to buyer fault and keeps the item amount", () => {
  const row = mapEbayReturn({
    returnId: "9",
    orderId: "1-2",
    creationInfo: { reason: "ORDERED_ACCIDENTALLY", reasonType: "REMORSE", item: { sku: "99801" } },
    itemPrice: { value: 24.99 },
    shippingPrice: { value: 8.5 },
    state: "RETURN_REQUESTED",
  });
  assert.equal(row.fault, "buyer");
  assert.equal(row.item_cents, 2499);
  assert.equal(row.shipping_cents, 850);
  assert.equal(row.sku, "99801");
});
