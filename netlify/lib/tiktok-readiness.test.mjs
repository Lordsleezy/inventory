import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTikTokReadiness, suggestedTikTokPriceCents } from "./tiktok-readiness.mjs";

const base = { sku: "1", title: "A new item", condition: "New", package_sealed: true, upc: "123", ask_cents: 1499 };

test("TikTok readiness requires Floor fields, new condition, photo, taxonomy and shop confirmation", () => {
  const eligible = { photoCount: 1, taxonomyAvailable: true, connected: true, categoryMapped: true,
    categoryAllowed: true, requiredFields: [], brandVerified: true };
  const result = evaluateTikTokReadiness(base, eligible);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.reasons, []);
  assert.equal(evaluateTikTokReadiness({ ...base, upc: "" }, { ...eligible }).reasons[0], "UPC missing");
  assert.match(evaluateTikTokReadiness({ ...base, package_sealed: false }, eligible).reasons.join(" "), /opened packaging/);
  assert.match(evaluateTikTokReadiness({ ...base, condition: "Open box" }, eligible).reasons[0], /pre-owned approval/);
  assert.match(evaluateTikTokReadiness({ ...base, condition: "Defective" }, {}).reasons.join(" "), /Defective/);
  assert.match(evaluateTikTokReadiness({ ...base, title: "Christmas lights" }, {}).reasons.join(" "), /Christmas lights/);
  assert.match(evaluateTikTokReadiness({ ...base, title: "Deep fryer" }, {}).reasons.join(" "), /deep fryers/);
  assert.match(evaluateTikTokReadiness({ ...base, listing_specs: { do_not_list: true } }, {}).reasons.join(" "), /do-not-list/);
});

test("TikTok readiness requires a mapped allowed category, fetched rules, required values, and brand verification", () => {
  const eligible = { photoCount: 1, taxonomyAvailable: true, connected: true, categoryMapped: true,
    categoryAllowed: true, requiredFields: [{ name: "color", label: "Color" }], attributes: { color: "Blue" }, brandVerified: true };
  assert.equal(evaluateTikTokReadiness(base, eligible).status, "ready");
  assert.match(evaluateTikTokReadiness(base, { ...eligible, categoryMapped: false }).reasons.join(" "), /mapping missing/);
  assert.match(evaluateTikTokReadiness(base, { ...eligible, categoryAllowed: false }).reasons.join(" "), /unavailable, restricted/);
  assert.match(evaluateTikTokReadiness(base, { ...eligible, requiredFields: null }).reasons.join(" "), /not fetched/);
  assert.match(evaluateTikTokReadiness(base, { ...eligible, attributes: {} }).reasons.join(" "), /Color/);
  assert.match(evaluateTikTokReadiness({ ...base, brand: "Brand" }, { ...eligible, brandVerified: false }).reasons.join(" "), /brand authorization/);
});

test("TikTok price adds ten percent only below $15", () => {
  assert.equal(suggestedTikTokPriceCents(1499), 1649);
  assert.equal(suggestedTikTokPriceCents(1500), 1500);
  assert.equal(suggestedTikTokPriceCents(null), 0);
});
