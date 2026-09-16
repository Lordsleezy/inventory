import assert from "node:assert/strict";
import { test } from "node:test";
import { centsToMoneyString, discountOffRetail, formatUsd, moneyStringToCents } from "./money.ts";

test("empty money stays null, never zero", () => {
  assert.equal(moneyStringToCents(null), null);
  assert.equal(moneyStringToCents(""), null);
  assert.equal(moneyStringToCents(undefined), null);
  assert.equal(formatUsd(null), "");
  assert.equal(centsToMoneyString(null), null);
});

test("parses dollars to integer cents", () => {
  assert.equal(moneyStringToCents("1450.00"), 145000);
  assert.equal(moneyStringToCents("12.5"), 1250);
  assert.equal(moneyStringToCents(0), 0);
});

test("discount ignores missing prices", () => {
  assert.equal(discountOffRetail(null, 200000), null);
  assert.equal(discountOffRetail(100000, null), null);
  assert.equal(discountOffRetail(100000, 200000), 50);
});
