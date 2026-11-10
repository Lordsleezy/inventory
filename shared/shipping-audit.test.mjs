import test from "node:test";
import assert from "node:assert/strict";
import {
  billablePounds,
  buildFlatShippingPolicy,
  chargeToPublish,
  classifyListing,
  comparedShipping,
  groundAdvantagePostage,
  labelCostDollars,
  packageChangeLowers,
  priorityBeside,
  rollbackRows,
  shippingReviseChange,
  shouldBeCharge,
  zoneFromZip,
  zonePercentile,
} from "./shipping-audit.mjs";

test("Penryn zone chart sends Oklahoma City to zone 6 and Sacramento to zone 1", () => {
  assert.equal(zoneFromZip("73101"), 6);
  assert.equal(zoneFromZip("95814"), 1);
  assert.equal(zoneFromZip("10001"), 8);
  assert.equal(zoneFromZip(""), null);
});

test("past shipment zones pick an upper-middle zone", () => {
  assert.equal(zonePercentile([1, 2, 4, 6, 8], 0.65), 6);
});

test("a package correction is allowed only when the billable weight drops", () => {
  assert.equal(packageChangeLowers(
    { lengthIn: 36, widthIn: 28, heightIn: 3, weightLb: 8 },
    { lengthIn: 12, widthIn: 10, heightIn: 4, weightLb: 8 },
  ), true);
  assert.equal(packageChangeLowers(
    { lengthIn: 12, widthIn: 10, heightIn: 4, weightLb: 8 },
    { lengthIn: 36, widthIn: 28, heightIn: 3, weightLb: 8 },
  ), false);
});

test("dimensional weight uses 166 only after one cubic foot", () => {
  const small = billablePounds({ lengthIn: 10, widthIn: 8, heightIn: 6, weightLb: 2 });
  assert.equal(small.pounds, 2);
  const tube = billablePounds({ lengthIn: 62, widthIn: 8, heightIn: 8, weightLb: 2.5 });
  assert.ok(tube.pounds > 23 && tube.pounds < 25);
  assert.equal(billablePounds({ lengthIn: 0, widthIn: 8, heightIn: 8, weightLb: 2 }), null);
});

test("Ground Advantage commercial rate for 1 lb zone 6 is the 2026 card", () => {
  assert.equal(groundAdvantagePostage(1, 6), 10.18);
});

test("a long light tube includes dim weight and the over-30-inch fee", () => {
  const cost = labelCostDollars({ lengthIn: 62, widthIn: 8, heightIn: 8, weightLb: 2.5 }, 6);
  assert.ok(cost.ground > 53);
  assert.ok(cost.priority > cost.ground);
});

test("should-be covers the label after the eBay fee and stays at least $6", () => {
  assert.equal(shouldBeCharge(5), 6);
  const charged = shouldBeCharge(10.18);
  assert.ok(charged >= 10.18 / 0.851);
  assert.equal(charged * 2, Math.round(charged * 2));
});

test("Priority-only shipping is judged against Priority, not Ground Advantage", () => {
  const onlyPriority = comparedShipping({ ground: null, priority: 47.48, groundShould: 36.5, priorityShould: 65.5 });
  assert.equal(onlyPriority.service, "Priority Mail");
  assert.equal(classifyListing({ currentCheapest: onlyPriority.current, shouldBe: onlyPriority.shouldBe, missing: false }), "too_low");
  const ground = comparedShipping({ ground: 42.15, priority: 63.33, groundShould: 25, priorityShould: 44 });
  assert.equal(classifyListing({ currentCheapest: ground.current, shouldBe: ground.shouldBe, missing: false }), "too_high");
});

test("the flat ten-dollar tier is left alone unless it is clearly high", () => {
  assert.equal(classifyListing({ currentCheapest: 10.5, shouldBe: 8, missing: false }), "fine");
  assert.equal(classifyListing({ currentCheapest: 10.5, shouldBe: 6, missing: false }), "too_high");
  assert.equal(classifyListing({ currentCheapest: 37, shouldBe: 20, missing: false }), "too_high");
  assert.equal(classifyListing({ currentCheapest: 11.68, shouldBe: 24, missing: false }), "too_low");
  assert.equal(classifyListing({ currentCheapest: 11, shouldBe: null, missing: true }), "cant_tell");
});

test("publishing never raises and never edits a fine or too-low listing", () => {
  assert.equal(chargeToPublish(37, 20, "too_high"), 20);
  assert.equal(chargeToPublish(10.5, 6, "too_high"), 6);
  assert.equal(chargeToPublish(11.68, 24, "too_low"), null);
  assert.equal(chargeToPublish(10.5, 9, "fine"), null);
  assert.equal(chargeToPublish(12, 12, "too_high"), null);
});

test("Priority stays the real USPS gap above Ground Advantage", () => {
  const next = priorityBeside(12, 10, 15);
  assert.ok(next > 12);
  assert.ok(next < 20);
});

test("a new flat policy puts Ground Advantage first and does not touch price, title, or handling", () => {
  const sourceHandling = { value: 2, unit: "DAY" };
  const policy = buildFlatShippingPolicy({
    name: "Floor ship audit $15.00 / $20.50",
    handlingTime: sourceHandling,
    groundDollars: 15,
    priorityDollars: 20.5,
    localPickup: false,
  });
  const services = policy.shippingOptions[0].shippingServices;
  assert.equal(services[0].shippingServiceCode, "USPSParcel");
  assert.equal(services[0].sortOrder, 1);
  assert.equal(services[0].shippingCost.value, "15.00");
  assert.equal(services[1].shippingServiceCode, "USPSPriority");
  assert.equal(services[1].sortOrder, 2);
  assert.equal(policy.handlingTime, sourceHandling);
  assert.equal(policy.localPickup, false);
  const blob = JSON.stringify(policy);
  assert.equal(blob.includes("StartPrice"), false);
  assert.equal(blob.includes("Title"), false);
});

test("a shipping revise sends policy ids only", () => {
  const change = shippingReviseChange({
    listingId: "820249925445",
    fulfillmentPolicyId: "new",
    paymentPolicyId: "pay",
    returnPolicyId: "ret",
    price: 11.99,
    title: "glasses",
  });
  assert.deepEqual(Object.keys(change).sort(), ["fulfillmentPolicyId", "itemId", "paymentPolicyId", "returnPolicyId"]);
  assert.equal(change.itemId, "820249925445");
});

test("rollback restores only the saved shipping policy", () => {
  const rows = rollbackRows([{ listingId: "820", sku: "1", fromPolicyId: "old", paymentPolicyId: "pay", returnPolicyId: "ret", title: "nope" }]);
  assert.deepEqual(rows, [{ listingId: "820", sku: "1", fulfillmentPolicyId: "old", paymentPolicyId: "pay", returnPolicyId: "ret" }]);
  assert.equal(Object.hasOwn(rows[0], "title"), false);
});
