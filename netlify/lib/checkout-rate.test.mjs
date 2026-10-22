import test from "node:test";
import assert from "node:assert/strict";
import { resetRateLimits } from "./listing-feed.mjs";
import { clientAddress, takeCheckoutRate } from "./checkout-rate.mjs";

test("checkout pay is limited to 8 attempts per address", () => {
  resetRateLimits();
  const now = 1_700_000_000_000;
  for (let i = 0; i < 8; i += 1) {
    assert.equal(takeCheckoutRate("pay", "203.0.113.8", now).ok, true);
  }
  const blocked = takeCheckoutRate("pay", "203.0.113.8", now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.reset >= 1);
  assert.equal(takeCheckoutRate("pay", "203.0.113.9", now).ok, true);
  assert.equal(takeCheckoutRate("begin", "203.0.113.8", now).ok, true);
});

test("checkout uses the Netlify client address", () => {
  assert.equal(clientAddress({ "x-nf-client-connection-ip": "198.51.100.4", "x-forwarded-for": "1.2.3.4" }), "198.51.100.4");
  assert.equal(clientAddress({ "X-Forwarded-For": "198.51.100.10, 10.0.0.1" }), "198.51.100.10");
});
