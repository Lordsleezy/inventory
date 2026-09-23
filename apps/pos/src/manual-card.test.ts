import { test } from "node:test";
import assert from "node:assert/strict";
import { manualRefundMessage } from "./manual-card.ts";

test("card void tells clerk to refund full recorded amount including fee", () => {
  assert.equal(manualRefundMessage("card", 10993, 0), "Ticket voided. Refund $109.93 in the Square app.");
});
test("split void keeps cash separate and never adds fee twice", () => {
  assert.equal(manualRefundMessage("split", 7918, 3000), "Ticket voided. Refund $79.18 in the Square app. Return $30.00 cash from the drawer.");
});
test("unknown refund amount must block void", () => {
  assert.throws(() => manualRefundMessage("card", null as unknown as number, 0));
});
