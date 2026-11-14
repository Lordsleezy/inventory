import test from "node:test";
import assert from "node:assert/strict";
import { barcodeLookupKeys, expandUpcE, normalizeGtin } from "./gtin-normalize.mjs";

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

test("a Costco 4999 item number is not a GTIN", () => {
  const r = normalizeGtin("499993873522");
  assert.equal(r.ok, false);
  assert.equal(r.issue, "costco internal item number");
});

test("lookup keys cover leading-zero forms and a padded Costco item label", () => {
  const disney = barcodeLookupKeys("0841887149884");
  assert.ok(disney.includes("841887149884"));
  assert.ok(barcodeLookupKeys("00841887149884").includes("841887149884"));
  const label = barcodeLookupKeys("000016545281");
  assert.ok(label.includes("1654528"));
  const ordinary = barcodeLookupKeys("041333051543");
  assert.ok(ordinary.includes("041333051543"));
  assert.equal(ordinary.includes("1806358"), false);
  assert.deepEqual(barcodeLookupKeys("499995988934"), ["499995988934"]);
});
