import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SKU_DIGITS, isSku, padSku, skuCeiling, storagePathForPhoto } from "./sku.ts";

test("SKU helpers default to five digits without baking 5 into callers", () => {
  assert.equal(DEFAULT_SKU_DIGITS, 5);
  assert.equal(isSku("10000"), true);
  assert.equal(isSku("123"), false);
  assert.equal(padSku(12), "00012");
  assert.equal(skuCeiling(), 99999);
});

test("SKU helpers accept a longer width later", () => {
  assert.equal(isSku("100000", 6), true);
  assert.equal(isSku("10000", 6), false);
  assert.equal(padSku(12, 6), "000012");
  assert.equal(skuCeiling(6), 999999);
});

test("photo storage paths nest under store then SKU", () => {
  const store = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    storagePathForPhoto(store, "11203", "photos/11203/abc.jpeg"),
    `${store}/11203/abc.jpeg`,
  );
  assert.equal(
    storagePathForPhoto(store, "11130", "11130/front.jpg"),
    `${store}/11130/front.jpg`,
  );
});

test("photo paths refuse a missing store id", () => {
  assert.throws(() => storagePathForPhoto("not-a-uuid", "11203", "a.jpg"));
});
