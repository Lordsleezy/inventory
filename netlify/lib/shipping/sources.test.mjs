import test from "node:test";
import assert from "node:assert/strict";
import {
  channelAllowsLabels,
  decodeRateId,
  encodeRateId,
  pickCheapestRate,
  rateForbiddenForChannel,
  sourcesForChannel,
} from "./sources.mjs";

test("Depop is excluded; eBay/Amazon/TikTok/website allowed", () => {
  assert.equal(channelAllowsLabels("depop"), false);
  assert.equal(channelAllowsLabels("ebay"), true);
  assert.equal(channelAllowsLabels("amazon"), true);
  assert.equal(channelAllowsLabels("tiktok"), true);
  assert.equal(channelAllowsLabels("website"), true);
});

test("TikTok forbids USPS from Shippo/Veeqo but allows TikTok Shipping USPS", () => {
  assert.equal(rateForbiddenForChannel("tiktok", { source: "shippo", carrier: "USPS" }), true);
  assert.equal(rateForbiddenForChannel("tiktok", { source: "veeqo", carrier: "USPS" }), true);
  assert.equal(rateForbiddenForChannel("tiktok", { source: "tiktok", carrier: "USPS" }), false);
  assert.equal(rateForbiddenForChannel("tiktok", { source: "shippo", carrier: "UPS" }), false);
  assert.equal(rateForbiddenForChannel("ebay", { source: "shippo", carrier: "USPS" }), false);
});

test("pick cheapest; Amazon prefers protected within N cents", () => {
  const rates = [
    { id: "shippo:a", source: "shippo", amount_cents: 1000, carrier: "USPS", days: 5 },
    { id: "veeqo:b", source: "veeqo", amount_cents: 1003, carrier: "UPS", days: 4, protection: "amazon_buy_shipping" },
    { id: "shippo:c", source: "shippo", amount_cents: 1200, carrier: "UPS", days: 3 },
  ];
  assert.equal(pickCheapestRate(rates, { channel: "ebay" }).rate.id, "shippo:a");
  assert.equal(pickCheapestRate(rates, { channel: "amazon", preferAmazonWithinCents: 5 }).rate.id, "veeqo:b");
  assert.equal(pickCheapestRate(rates, { channel: "amazon", preferAmazonWithinCents: 0 }).rate.id, "shippo:a");
});

test("TikTok source list includes TikTok first; website is Shippo-only", () => {
  assert.deepEqual(sourcesForChannel("website"), ["shippo"]);
  assert.ok(sourcesForChannel("tiktok").includes("tiktok"));
  assert.ok(sourcesForChannel("ebay").includes("ebay_logistics"));
});

test("rate id encode/decode", () => {
  assert.equal(encodeRateId("veeqo", "abc"), "veeqo:abc");
  assert.deepEqual(decodeRateId("veeqo:abc:def"), { source: "veeqo", remoteId: "abc:def" });
});

test("Shippo quota/payment heuristic", async () => {
  const { shippoQuotaOrPaymentError, shippoPlanNote } = await import("../shippo.mjs");
  assert.equal(shippoQuotaOrPaymentError({ message: "shippo_402", detail: { detail: "payment required" } }), true);
  assert.equal(shippoQuotaOrPaymentError({ message: "shippo_400", detail: { detail: "address invalid" } }), false);
  assert.match(shippoPlanNote(), /30 labels/i);
});
