import test from "node:test";
import assert from "node:assert/strict";
import { keepStockJudgment } from "./stock-photo-verify.mjs";

test("a box back or a different product is not a stock photo", () => {
  assert.equal(keepStockJudgment({ same_product: true, shot: "product", low_quality: false }), true);
  assert.equal(keepStockJudgment({ same_product: true, shot: "box_front", low_quality: false }), true);
  assert.equal(keepStockJudgment({ same_product: true, shot: "box_back", low_quality: false }), false);
  assert.equal(keepStockJudgment({ same_product: true, shot: "warning", low_quality: false }), false);
  assert.equal(keepStockJudgment({ same_product: false, shot: "product", low_quality: false }), false);
  assert.equal(keepStockJudgment({ same_product: true, shot: "product", low_quality: true }), false);
});
