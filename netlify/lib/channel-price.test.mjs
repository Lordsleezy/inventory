import test from "node:test";
import assert from "node:assert/strict";
import { calcListPrice, getFeeConfig } from "./marketplace-pricing.mjs";

test("Amazon and TikTok are in the fee table and price from the Floor ask", () => {
  const config = getFeeConfig();
  assert.equal(config.marketplaces.amazon.rate, 0.15);
  assert.equal(config.marketplaces.tiktok.rate, 0.08);
  const ebay = calcListPrice(2000, "ebay", 0, 200, 0);
  const amazon = calcListPrice(2000, "amazon", 800, 200, 10);
  const tiktok = calcListPrice(2000, "tiktok", 800, 200, 10);
  assert.ok(ebay > 2000);
  assert.ok(amazon > ebay);
  assert.ok(tiktok > 2000);
  assert.equal(calcListPrice(2000, "website", 500, 200, 10), 2000);
});
