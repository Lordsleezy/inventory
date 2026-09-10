import assert from "node:assert/strict";
import test from "node:test";

import { centsToInput, formatCents, formatCentsTotal, parseMoneyToCents } from "./money.ts";

test("blank input is blank, not zero", () => {
  assert.equal(parseMoneyToCents(""), null);
  assert.equal(parseMoneyToCents("   "), null);
  assert.equal(parseMoneyToCents(null), null);
  assert.equal(parseMoneyToCents(undefined), null);
});

test("an explicit zero is zero, which is a different fact from blank", () => {
  assert.equal(parseMoneyToCents("0"), 0);
  assert.equal(parseMoneyToCents("0.00"), 0);
});

test("prices parse to integer cents", () => {
  assert.equal(parseMoneyToCents("19.99"), 1999);
  assert.equal(parseMoneyToCents("$1,250"), 125000);
  assert.equal(parseMoneyToCents("7"), 700);
  assert.equal(parseMoneyToCents("7.5"), 750);
  assert.equal(parseMoneyToCents("0.05"), 5);
});

test("junk is rejected rather than silently becoming a number", () => {
  for (const bad of ["abc", "12.345", "-5", "1.2.3", "1e3"]) {
    assert.equal(parseMoneyToCents(bad), undefined, `${bad} should not parse`);
  }
});

test("a blank price renders blank and never $0.00", () => {
  assert.equal(formatCents(null), "");
  assert.equal(formatCents(undefined), "");
  assert.equal(centsToInput(null), "");
});

test("prices render as money", () => {
  assert.equal(formatCents(0), "$0.00");
  assert.equal(formatCents(1999), "$19.99");
  assert.equal(formatCents(125000), "$1,250.00");
  assert.equal(formatCents(5), "$0.05");
});

test("input fields round-trip without a currency symbol", () => {
  for (const cents of [0, 5, 750, 1999, 125000]) {
    assert.equal(parseMoneyToCents(centsToInput(cents)), cents);
  }
});

test("a total of zero is a real zero", () => {
  assert.equal(formatCentsTotal(0), "$0.00");
  assert.equal(formatCentsTotal(1999), "$19.99");
});
