import assert from "node:assert/strict";
import test from "node:test";
import { shipCandidateBlocked } from "./ebay-ship-list.mjs";

test("shipCandidateBlocked rejects missing price and sold state", () => {
  assert.equal(shipCandidateBlocked(null), "missing_unit");
  assert.equal(shipCandidateBlocked({ state: "sold", ask_cents: 9999 }), "state_sold");
  assert.equal(shipCandidateBlocked({ state: "available", ask_cents: 0 }), "no_price");
  assert.equal(shipCandidateBlocked({ state: "available", ask_cents: 9999, is_test: true }), "test_unit");
  assert.equal(shipCandidateBlocked({ state: "available", ask_cents: 9999 }), null);
});
