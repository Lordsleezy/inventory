import assert from "node:assert/strict";
import test from "node:test";
import { xmlEsc, tradingConditionId } from "./ebay-trading.mjs";

test("xmlEsc encodes markup so Trading API XML stays well-formed", () => {
  assert.equal(xmlEsc(`A & B <C>`), "A &amp; B &lt;C&gt;");
});

test("eBay REST conditions map to Trading ConditionID", () => {
  assert.equal(tradingConditionId("NEW"), "1000");
  assert.equal(tradingConditionId("LIKE_NEW"), "1500");
  assert.equal(tradingConditionId("USED_GOOD"), "3000");
  assert.equal(tradingConditionId("FOR_PARTS_OR_NOT_WORKING"), "7000");
});
