import assert from "node:assert/strict";
import test from "node:test";
import { bundlePriceApplyEnabled, BUNDLE_PRICE_APPLY_OFF_MESSAGE } from "./bundle-apply-gate.mjs";

test("bundle price apply is off unless FLOOR_BUNDLE_PRICE_APPLY=1", () => {
  const prev = process.env.FLOOR_BUNDLE_PRICE_APPLY;
  try {
    delete process.env.FLOOR_BUNDLE_PRICE_APPLY;
    assert.equal(bundlePriceApplyEnabled(), false);
    process.env.FLOOR_BUNDLE_PRICE_APPLY = "0";
    assert.equal(bundlePriceApplyEnabled(), false);
    process.env.FLOOR_BUNDLE_PRICE_APPLY = "1";
    assert.equal(bundlePriceApplyEnabled(), true);
    assert.match(BUNDLE_PRICE_APPLY_OFF_MESSAGE, /FLOOR_BUNDLE_PRICE_APPLY/);
  } finally {
    if (prev == null) delete process.env.FLOOR_BUNDLE_PRICE_APPLY;
    else process.env.FLOOR_BUNDLE_PRICE_APPLY = prev;
  }
});
