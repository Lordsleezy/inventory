import test from "node:test";
import assert from "node:assert/strict";
import { resolveDropshipReturnDefault } from "./returns.mjs";
import { __test as tt } from "./publish-tiktok.mjs";
import { amazonShouldIngestDropship } from "./amazon-readiness.mjs";

test("cheap items default to refund-and-keep", () => {
  const plan = resolveDropshipReturnDefault("change of mind", 1800, { refund_keep_threshold_cents: 2500 });
  assert.equal(plan.resolution, "refund_and_keep");
  assert.equal(plan.needs_paul, true);
});

test("change of mind above threshold is buyer-paid return", () => {
  const plan = resolveDropshipReturnDefault("change of mind / unused", 5000);
  assert.equal(plan.resolution, "return_then_resell");
  assert.equal(plan.who_pays_return_shipping, "buyer");
});

test("defective is seller fault with supplier claim", () => {
  const plan = resolveDropshipReturnDefault("damaged / defective", 4000);
  assert.equal(plan.resolution, "refund_and_keep");
  assert.equal(plan.who_pays_return_shipping, "seller");
  assert.equal(plan.open_supplier_claim, true);
});

test("never claims auto-refund — always needs Paul", () => {
  for (const reason of ["change of mind", "defective", "wrong item", "mystery"]) {
    assert.equal(resolveDropshipReturnDefault(reason, 9999).needs_paul, true);
  }
});

test("tiktok blocks restricted categories", () => {
  const excl = new Set(["alcohol", "kids", "weapons", "adult"]);
  assert.equal(tt.tiktokCategoryBlock("Kids Toddler Cup", excl), "kids");
  assert.equal(tt.tiktokCategoryBlock("Stainless Tongs", excl), null);
  assert.equal(tt.tiktokCategoryBlock("Wine Opener Set alcohol kit", excl), "alcohol");
});

test("amazon ingest stays locked until unlocked", () => {
  assert.equal(amazonShouldIngestDropship({ enabled: true, amazon_channel_on: true }, { unlocked: false }), false);
  assert.equal(amazonShouldIngestDropship({ enabled: true, amazon_channel_on: true }, { unlocked: true }), true);
  assert.equal(amazonShouldIngestDropship({ enabled: true, amazon_channel_on: false }, { unlocked: true }), false);
});
