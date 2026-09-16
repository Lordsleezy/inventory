import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSkuFromSerials } from "./sku-math.ts";

test("next SKU is skuStart when the warehouse is empty", () => {
  assert.equal(nextSkuFromSerials([], 11111), "11111");
});

test("next SKU is one past the highest existing 5-digit serial", () => {
  assert.equal(nextSkuFromSerials(["11111", "11115", "19999"], 11111), "20000");
});

test("non-SKU serials do not count", () => {
  assert.equal(nextSkuFromSerials(["pk-9", "abc"], 10000), "10000");
});
