import test from "node:test";
import assert from "node:assert/strict";
import {
  breakEvenPickupCents,
  pickupListPriceCents,
  pickupCandidateBlocked,
} from "./ebay-pickup-list.mjs";
import { isLocalPickupOnlyPolicy, pickupOnlyFulfillmentBody, POLICY_NAMES } from "./ebay-policies.mjs";

test("break-even covers $9 cost at 13% fee, rounded to a whole dollar", () => {
  // 900 / 0.87 ≈ 1034.48 → $11.00
  assert.equal(breakEvenPickupCents(900, 13), 1100);
  assert.equal(breakEvenPickupCents(900, 13.25), 1100);
});

test("pickup price uses Floor ask when it is already below break-even", () => {
  assert.equal(pickupListPriceCents(999, { costCents: 900, feePct: 13 }), 999);
  assert.equal(pickupListPriceCents(1599, { costCents: 900, feePct: 13 }), 1100);
});

test("blocks scooter / vinyl / collectibles", () => {
  assert.equal(pickupCandidateBlocked({ sku: "11284", state: "available", ask_cents: 500, title: "scooter" }), "do_not_list_scooter");
  assert.equal(
    pickupCandidateBlocked({ sku: "1", state: "available", ask_cents: 500, title: "vinyl record", is_collectible: false }),
    "blocked_category_or_title",
  );
  assert.equal(
    pickupCandidateBlocked({ sku: "2", state: "available", ask_cents: 500, title: "lamp", is_collectible: true }),
    "collectible",
  );
  assert.equal(pickupCandidateBlocked({ sku: "3", state: "available", ask_cents: 999, title: "storage bins" }), null);
});

test("pickup-only fulfillment body has localPickup and no shipping services", () => {
  const body = pickupOnlyFulfillmentBody("EBAY_US");
  assert.equal(body.name, POLICY_NAMES.localPickup);
  assert.equal(body.localPickup, true);
  assert.equal(body.shippingOptions, undefined);
  assert.equal(isLocalPickupOnlyPolicy({ localPickup: true, shippingOptions: [] }), true);
  assert.equal(
    isLocalPickupOnlyPolicy({
      localPickup: true,
      shippingOptions: [{ shippingServices: [{ shippingServiceCode: "USPSPriority" }] }],
    }),
    false,
  );
});
