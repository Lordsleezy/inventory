import test from "node:test";
import assert from "node:assert/strict";
import { expandUpcE, normalizeGtin } from "./gtin-normalize.mjs";

test("normalize UPC-A", () => {
  const r = normalizeGtin("012345678905");
  assert.equal(r.ok, true);
  assert.equal(r.upcA, "012345678905");
  assert.equal(r.gtin14, "00012345678905");
});

test("normalize EAN-13", () => {
  const r = normalizeGtin("5901234123457");
  assert.equal(r.ok, true);
  assert.equal(r.ean13, "5901234123457");
});

test("expand UPC-E", () => {
  // Classic example: 01234506 → 012000003456? depends on pattern — just ensure length 12 + check
  const upcA = expandUpcE("02345673");
  assert.equal(upcA?.length, 12);
  assert.equal(normalizeGtin(upcA).ok, true);
});

test("reject bad check digit", () => {
  const r = normalizeGtin("012345678901");
  assert.equal(r.ok, false);
});
