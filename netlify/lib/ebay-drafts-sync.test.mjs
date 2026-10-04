import test from "node:test";
import assert from "node:assert/strict";
import { rowChanged } from "./ebay-drafts.mjs";

const stored = {
  store_id: "s", sku: "1", title: "Blender", status: "draft", price_cents: 4999, label_cents: 900,
  aspects: { Brand: "Acme", Color: "Red" }, checklist: [{ label: "Needs box size", ok: true }],
  photo_paths: ["a.jpg", "b.jpg"], updated_at: "2026-10-04T01:00:00+00:00",
};

test("an unchanged draft is not rewritten (updated_at and key order do not count)", () => {
  const next = { ...stored, updated_at: new Date().toISOString(), aspects: { Color: "Red", Brand: "Acme" } };
  assert.equal(rowChanged(next, stored), false);
});

test("any real change, or a brand-new draft, is written", () => {
  assert.equal(rowChanged({ ...stored, price_cents: 5099 }, stored), true);
  assert.equal(rowChanged({ ...stored, aspects: { Brand: "Acme" } }, stored), true);
  assert.equal(rowChanged({ ...stored, photo_paths: ["a.jpg"] }, stored), true);
  assert.equal(rowChanged(stored, undefined), true);
});

test("fields that are never persisted do not trigger writes", () => {
  const next = { ...stored, floor_cents: 12345, box: { length_in: 1 }, quotes: { x: 1 }, unit_brand: "Acme" };
  assert.equal(rowChanged(next, stored), false);
});
