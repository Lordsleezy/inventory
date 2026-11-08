import test from "node:test";
import assert from "node:assert/strict";
import { isDropshipSku, normalizeTitle, dollarsToCents } from "./types.mjs";
import { assertChannelAllowsDropship } from "./autopilot.mjs";

test("DS- SKU detection", () => {
  assert.equal(isDropshipSku("DS-00001"), true);
  assert.equal(isDropshipSku("ds-12"), true);
  assert.equal(isDropshipSku("11871"), false);
  assert.equal(isDropshipSku("DS-ABC"), false);
});

test("normalizeTitle collapses punctuation", () => {
  assert.equal(normalizeTitle("  Hello, WORLD!! "), "hello world");
});

test("dollarsToCents", () => {
  assert.equal(dollarsToCents("9.50"), 950);
  assert.equal(dollarsToCents(null), 0);
});

test("Depop and Mercari hard-block DS- SKUs", () => {
  assert.throws(() => assertChannelAllowsDropship("depop", "DS-00001"), /dropship_blocked/);
  assert.throws(() => assertChannelAllowsDropship("mercari", "DS-00002"), /dropship_blocked/);
  assert.doesNotThrow(() => assertChannelAllowsDropship("ebay", "DS-00001"));
  assert.doesNotThrow(() => assertChannelAllowsDropship("depop", "11871"));
});
