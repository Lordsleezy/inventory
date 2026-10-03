import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMarket } from "./ebay-market.mjs";

test("retail uses the highest current price", () => {
  const market = summarizeMarket("retail", [
    { store: "Home Depot", price_cents: 32900, pack_size: 1, url: "https://example.com/a" },
    { store: "Walmart", price_cents: 54900, pack_size: 1, url: "https://example.com/b" },
    { store: "Pack", price_cents: 60000, pack_size: 2, approximate: true, url: "https://example.com/c" },
  ]);
  assert.equal(market.cents, 54900);
  assert.equal(market.store, "Walmart");
});

test("collectibles use the average of sold prices", () => {
  const market = summarizeMarket("sold", [
    { price_cents: 8000, pack_size: 1, url: "https://example.com/1" },
    { price_cents: 10000, pack_size: 1, url: "https://example.com/2" },
    { price_cents: 12000, pack_size: 1, url: "https://example.com/3" },
  ]);
  assert.equal(market.kind, "sold");
  assert.equal(market.cents, 10000);
  assert.equal(market.count, 3);
});
