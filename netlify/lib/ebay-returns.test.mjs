import assert from "node:assert/strict";
import test from "node:test";
import { deductionRefundCents, ebayRefundPlan, mapEbayReturn } from "./ebay-returns.mjs";
import { ebayAccountFeedsFloorOrders } from "./ebay-accounts.mjs";
import { assertEbaySellerWrite } from "./ebay-write-guard.mjs";

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
  assert.equal(row.refund_cents, 2499);
  assert.equal(row.label_paid_by, "buyer");
  assert.equal(row.sku, "99801");
});

test("not as described refunds the item plus original shipping and hides the deduction", () => {
  const plan = ebayRefundPlan({
    reason: "not_as_described",
    fault: "seller",
    itemCents: 8999,
    shippingCents: 1370,
  });
  assert.equal(plan.refundCents, 10369);
  assert.equal(plan.includeOriginalShipping, true);
  assert.equal(plan.labelPaidBy, "seller");
  assert.equal(plan.deductionAllowed, false);
  const defective = mapEbayReturn({
    returnId: "5333006917",
    creationInfo: { reason: "DEFECTIVE_ITEM", reasonType: "SNAD", item: { sku: "11713" } },
    itemPrice: { value: 89.99 },
    originalShipping: { value: 13.7 },
    state: "RETURN_REQUESTED",
  });
  assert.equal(defective.fault, "seller");
  assert.equal(defective.refund_cents, 10369);
  assert.equal(defective.label_paid_by, "seller");
});

test("a listing or policy write aimed at pgg124-5 or any non-selling account is refused", () => {
  assert.throws(
    () => assertEbaySellerWrite({ username: "pgg124-5", role: "orders" }),
    /pgg124-5 is read-only/,
  );
  assert.throws(
    () => assertEbaySellerWrite({ username: "someone-else", role: "selling" }),
    /ikonikdeals2026/,
  );
  assert.throws(
    () => assertEbaySellerWrite({ username: "ikonikdeals2026", role: "orders" }),
    /ikonikdeals2026/,
  );
  assert.equal(assertEbaySellerWrite({ username: "ikonikdeals2026", role: "selling" }).username, "ikonikdeals2026");
  assert.equal(ebayAccountFeedsFloorOrders({ username: "ikonikdeals2026", role: "selling" }), true);
  assert.equal(ebayAccountFeedsFloorOrders({ username: "pgg124-5", role: "orders_only" }), false);
  assert.equal(ebayAccountFeedsFloorOrders({ username: "pgg124-5", role: "selling" }), false);
});
