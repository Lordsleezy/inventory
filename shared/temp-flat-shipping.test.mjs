import test from "node:test";
import assert from "node:assert/strict";
import {
  TEMP_FLAT_CENTS,
  chooseTempFlat,
  flatRatePolicyBody,
  offerBodyWithPolicy,
  purchasesFromEbayOrders,
  shouldRevertTempFlat,
  tempFlatLine,
} from "./temp-flat-shipping.mjs";

const gummies = { sku: "99763", listing_id: "820301248330", title: "Kids Gruns gummies", shipping_cents: 1085, weight_lb: 1 };
const candle = { sku: "99871", listing_id: "820294916467", title: "APOTHEKE candle", shipping_cents: 1240, weight_lb: 4 };
const lamp = { sku: "99874", listing_id: "820294716028", title: "Aurora lamp", shipping_cents: 1193, weight_lb: 2 };

test("the highest own shipping stays, and the other two are $1.99", () => {
  const choice = chooseTempFlat([gummies, lamp, candle]);
  assert.equal(choice.ok, true);
  assert.equal(choice.kept.sku, "99871");
  assert.deepEqual(choice.discount.map((item) => item.sku).sort(), ["99763", "99874"]);
  assert.equal(choice.total_cents, 1240 + TEMP_FLAT_CENTS + TEMP_FLAT_CENTS);
  assert.ok(choice.total_cents >= 1600);
});

test("a local zip where every rate is about $10 still keeps the highest of those rates", () => {
  const choice = chooseTempFlat([
    { ...gummies, shipping_cents: 1023 },
    { ...candle, shipping_cents: 1028 },
    { ...lamp, shipping_cents: 1050 },
  ]);
  assert.equal(choice.kept.sku, "99874");
  assert.equal(choice.total_cents, 1050 + 199 + 199);
});

test("the flat policy is Ground Advantage at $1.99 with the same two-day handling", () => {
  const body = flatRatePolicyBody();
  assert.equal(body.name, "Floor temp flat $1.99 GA");
  assert.equal(body.handlingTime.value, 2);
  assert.equal(body.shippingOptions[0].costType, "FLAT_RATE");
  assert.equal(body.shippingOptions[0].shippingServices[0].shippingServiceCode, "USPSParcel");
  assert.equal(body.shippingOptions[0].shippingServices[0].shippingCost.value, "1.99");
  assert.equal(body.shippingOptions[0].shippingServices[0].freeShipping, false);
});

test("attaching the policy does not rewrite the price", () => {
  const body = offerBodyWithPolicy({
    offerId: "1",
    status: "PUBLISHED",
    listing: { listingId: "820" },
    pricingSummary: { price: { value: "16.99", currency: "USD" } },
    listingPolicies: { fulfillmentPolicyId: "old", paymentPolicyId: "pay", returnPolicyId: "ret" },
  }, "new-policy");
  assert.equal(body.offerId, undefined);
  assert.equal(body.pricingSummary.price.value, "16.99");
  assert.equal(body.listingPolicies.fulfillmentPolicyId, "new-policy");
  assert.equal(body.listingPolicies.paymentPolicyId, "pay");
  assert.equal(body.listingPolicies.returnPolicyId, "ret");
});

const hold = {
  active: true,
  buyer: "fullcontactshopper",
  expires_at: "2026-11-12T06:00:00.000Z",
  kept: candle,
  items: [gummies, lamp],
};

test("nothing reverts before a purchase or the 48-hour mark", () => {
  const waiting = shouldRevertTempFlat(hold, { now: Date.parse("2026-11-10T06:00:00.000Z"), orders: [] });
  assert.equal(waiting.revert, false);
  const later = shouldRevertTempFlat(hold, { now: Date.parse("2026-11-12T06:00:00.000Z"), orders: [] });
  assert.equal(later.revert, true);
  assert.match(later.reason, /48 hours/);
});

test("the named buyer purchasing, or anyone buying a $1.99 listing, reverts once", () => {
  const customer = shouldRevertTempFlat(hold, {
    now: Date.parse("2026-11-10T08:00:00.000Z"),
    orders: [{ buyer: "fullcontactshopper", listing_ids: [candle.listing_id], order_id: "1" }],
  });
  assert.equal(customer.revert, true);
  assert.match(customer.reason, /fullcontactshopper/);
  const stranger = shouldRevertTempFlat(hold, {
    now: Date.parse("2026-11-10T08:00:00.000Z"),
    orders: [{ buyer: "someone", listing_ids: [lamp.listing_id], order_id: "2" }],
  });
  assert.equal(stranger.revert, true);
  assert.match(stranger.reason, /someone else/);
  const canceled = shouldRevertTempFlat(hold, {
    now: Date.parse("2026-11-10T08:00:00.000Z"),
    orders: [{ buyer: "fullcontactshopper", listing_ids: [gummies.listing_id], canceled: true }],
  });
  assert.equal(canceled.revert, false);
  const otherSale = shouldRevertTempFlat(hold, {
    now: Date.parse("2026-11-10T08:00:00.000Z"),
    orders: [{ buyer: "someone", listing_ids: [candle.listing_id] }],
  });
  assert.equal(otherSale.revert, false);
  const done = shouldRevertTempFlat({ ...hold, active: false, reverted_at: "2026-11-10T09:00:00.000Z" }, {
    now: Date.parse("2026-11-10T10:00:00.000Z"),
    orders: [{ buyer: "fullcontactshopper", listing_ids: [gummies.listing_id] }],
  });
  assert.equal(done.revert, false);
});

test("a canceled eBay order is not a purchase, and a paid line is", () => {
  const rows = purchasesFromEbayOrders([
    {
      orderId: "06-1",
      buyer: { username: "fullcontactshopper" },
      cancelStatus: { cancelState: "CANCELED" },
      lineItems: [{ legacyItemId: "820301248330" }],
    },
    {
      orderId: "07-1",
      buyer: { username: "fullcontactshopper" },
      orderPaymentStatus: "PAID",
      lineItems: [{ legacyItemId: "820294716028" }],
    },
  ]);
  assert.equal(rows[0].canceled, true);
  assert.equal(rows[1].canceled, false);
  assert.deepEqual(rows[1].listing_ids, ["820294716028"]);
  const decision = shouldRevertTempFlat(hold, {
    now: Date.parse("2026-11-10T08:00:00.000Z"),
    orders: rows,
  });
  assert.equal(decision.revert, true);
  assert.equal(decision.order_id, "07-1");
});

test("Orders says the two listings are temporary, and says when they were put back", () => {
  const live = tempFlatLine(hold);
  assert.match(live, /Temporary \$1\.99 shipping is on/);
  assert.match(live, /99763/);
  assert.match(live, /99874/);
  assert.match(live, /99871/);
  assert.match(live, /fullcontactshopper/);
  assert.match(live, /normal shipping/);
  const back = tempFlatLine({
    ...hold,
    active: false,
    reverted_at: "2026-11-10T18:00:00.000Z",
    revert_reason: "fullcontactshopper bought one",
  });
  assert.match(back, /was put back/);
  assert.match(back, /fullcontactshopper bought one/);
});
