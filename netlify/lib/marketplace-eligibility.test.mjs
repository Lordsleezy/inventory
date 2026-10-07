import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CHANNEL_RULES,
  evaluateMarketplaceEligibility,
  inferIsCamera,
  inferRequiresPower,
} from "./marketplace-eligibility.mjs";

const sonic = {
  sku: "11999",
  title: "Philips Sonicare Rechargeable Toothbrush",
  brand: "Philips",
  category: "Electric Toothbrushes",
  requires_power: true,
  has_stock_photos: false,
  has_ai_images: false,
};

test("Depop blocks rechargeable electronics", () => {
  const r = evaluateMarketplaceEligibility(sonic, DEFAULT_CHANNEL_RULES.depop, { channelLabel: "Depop" });
  assert.equal(r.status, "block");
  assert.match(r.reason, /rechargeable|powered/i);
});

test("Depop allows cameras even if powered", () => {
  const cam = {
    title: "Canon EOS Rebel DSLR Camera",
    category: "Cameras",
    requires_power: true,
    is_camera: true,
  };
  const r = evaluateMarketplaceEligibility(cam, DEFAULT_CHANNEL_RULES.depop, { channelLabel: "Depop" });
  assert.equal(r.status, "allow");
});

test("Depop blocks chargers", () => {
  const r = evaluateMarketplaceEligibility(
    { title: "USB-C Charging Cable 6ft", category: "Accessories" },
    DEFAULT_CHANNEL_RULES.depop,
    { channelLabel: "Depop" },
  );
  assert.equal(r.status, "block");
  assert.match(r.reason, /charger|cable/i);
});

test("Depop blocks stock photos", () => {
  const r = evaluateMarketplaceEligibility(
    { title: "Ceramic mug", category: "Kitchen", requires_power: false, has_stock_photos: true },
    DEFAULT_CHANNEL_RULES.depop,
    { channelLabel: "Depop" },
  );
  assert.equal(r.status, "block");
  assert.match(r.reason, /stock photo/i);
});

test("strike beats override allow", () => {
  const r = evaluateMarketplaceEligibility(
    { title: "Mug", requires_power: false },
    DEFAULT_CHANNEL_RULES.depop,
    { channelLabel: "Depop", strike: true, override: { decision: "allow", note: "trust me" } },
  );
  assert.equal(r.status, "block");
  assert.equal(r.source, "strike");
});

test("manual override can allow a blocked item when no strike", () => {
  const r = evaluateMarketplaceEligibility(sonic, DEFAULT_CHANNEL_RULES.depop, {
    channelLabel: "Depop",
    override: { decision: "allow", note: "non-powered display model" },
  });
  assert.equal(r.status, "allow");
  assert.equal(r.source, "override");
});

test("unknown power goes to review on Depop", () => {
  const r = evaluateMarketplaceEligibility(
    { title: "Mystery box item", category: "Other" },
    DEFAULT_CHANNEL_RULES.depop,
    { channelLabel: "Depop" },
  );
  assert.equal(r.status, "review");
});

test("inferRequiresPower catches toothbrush wording", () => {
  assert.equal(inferRequiresPower({ title: "Sonicare toothbrush handle" }), true);
  assert.equal(inferIsCamera({ title: "Sony Alpha mirrorless camera body" }), true);
});

test("eBay still blocks alcohol via prohibited keywords", () => {
  const r = evaluateMarketplaceEligibility(
    { title: "Truly Hard Seltzer Variety 12 Pack", category: "Beverages", requires_power: false },
    DEFAULT_CHANNEL_RULES.ebay,
    { channelLabel: "eBay" },
  );
  assert.equal(r.status, "block");
});
