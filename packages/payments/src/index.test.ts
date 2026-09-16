import assert from "node:assert/strict";
import test from "node:test";
import { cashProvider, stubCardProvider } from "./index.ts";

test("cash charge always succeeds with a payment id", async () => {
  const result = await cashProvider.charge({ amountCents: 1999, currency: "USD" });
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.paymentId, /^cash_/);
});

test("card stub can decline or time out without charging", async () => {
  const declined = await stubCardProvider("decline").charge({ amountCents: 1, currency: "USD" });
  assert.equal(declined.ok, false);
  if (!declined.ok) assert.equal(declined.reason, "declined");
  const timeout = await stubCardProvider("timeout").charge({ amountCents: 1, currency: "USD" });
  assert.equal(timeout.ok, false);
  if (!timeout.ok) assert.equal(timeout.reason, "timeout");
});
