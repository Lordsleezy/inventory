import assert from "node:assert/strict";
import test from "node:test";
import {
  amazonQuantityPatch,
  debounceQtyRow,
  ebayInventoryQuantityBody,
  ebayOfferQuantityBody,
  orderLineQty,
  planChannelQuantity,
  saleLeavesStock,
  takeStock,
} from "./channel-qty-sync.mjs";

const channels = ["ebay", "amazon", "tiktok", "website"];

test("a stocked SKU is one listing per channel at the available quantity", () => {
  const plans = channels.map((channel) => planChannelQuantity({
    channel,
    available: 17,
    listing: { status: "listed", quantity: 1 },
  }));
  assert.deepEqual(plans.map((plan) => plan.quantity), [17, 17, 17, 17]);
  assert.deepEqual(plans.map((plan) => plan.op), ["set", "set", "set", "show"]);
});

test("selling 2 in store then 3 on eBay leaves 12 and one sale line", () => {
  let onHand = 17;
  const instore = takeStock({ onHand, qty: 2 });
  assert.equal(instore.ok, true);
  onHand = instore.onHand;
  assert.equal(onHand, 15);
  const ebay = takeStock({ onHand, qty: orderLineQty("ebay", { lineItems: [{ sku: "11500", quantity: 3 }] }) });
  assert.equal(ebay.ok, true);
  onHand = ebay.onHand;
  assert.equal(onHand, 12);
  const sale = { qty: 3, price_cents: 2500 * 3 };
  assert.equal(sale.qty, 3);
  assert.equal(sale.price_cents, 7500);
  for (const channel of channels) {
    const plan = planChannelQuantity({ channel, available: onHand, listing: { status: "listed", quantity: 15 } });
    assert.equal(plan.quantity, 12);
  }
});

test("selling out ends or zeroes listings and restock brings them back", () => {
  const soldOut = takeStock({ onHand: 12, qty: 12 });
  assert.equal(soldOut.onHand, 0);
  assert.equal(planChannelQuantity({ channel: "ebay", available: 0, listing: { status: "listed", quantity: 12 } }).op, "end");
  assert.equal(planChannelQuantity({ channel: "amazon", available: 0, listing: { status: "listed", quantity: 12 } }).op, "set");
  assert.equal(planChannelQuantity({ channel: "tiktok", available: 0, listing: { status: "listed", quantity: 12 } }).quantity, 0);
  assert.equal(planChannelQuantity({ channel: "website", available: 0, listing: { status: "listed", quantity: 12 } }).op, "hide");
  const back = 4;
  assert.equal(planChannelQuantity({ channel: "ebay", available: back, listing: { status: "ended", quantity: 0 } }).op, "relist");
  assert.equal(planChannelQuantity({ channel: "amazon", available: back, listing: { status: "listed", quantity: 0 } }).quantity, back);
  assert.equal(planChannelQuantity({ channel: "website", available: back, listing: { status: "hidden", quantity: 0 } }).op, "show");
});

test("the later order for the last units is cancelled and on-hand stays non-negative", () => {
  let onHand = 1;
  const instore = takeStock({ onHand, qty: 1 });
  assert.equal(instore.ok, true);
  onHand = instore.onHand;
  const online = takeStock({ onHand, qty: 1 });
  assert.equal(online.ok, false);
  assert.equal(online.reason, "unit_not_sellable");
  assert.equal(onHand, 0);
  assert.equal(takeStock({ onHand: 2, qty: 3, holds: 0 }).ok, false);
  assert.equal(takeStock({ onHand: 5, qty: 2, holds: 4 }).ok, false);
});

test("a partial return of 1 adds 1 back and the channels follow", () => {
  const onHand = 12 + 1;
  assert.equal(onHand, 13);
  const plan = planChannelQuantity({ channel: "ebay", available: onHand, listing: { status: "listed", quantity: 12 } });
  assert.equal(plan.op, "set");
  assert.equal(plan.quantity, 13);
});

test("quantity updates keep the existing price, title, photos, and offer terms", () => {
  const inventory = {
    sku: "11500",
    product: { title: "Holiday diffuser", imageUrls: ["https://example/a.jpg"], aspects: { Brand: ["Acme"] } },
    condition: "NEW",
    availability: { shipToLocationAvailability: { quantity: 1, availabilityDistributions: [{ merchantLocationKey: "penryn", quantity: 1 }] } },
  };
  const offer = {
    offerId: "offer-1",
    pricingSummary: { price: { value: "19.99", currency: "USD" } },
    listingPolicies: { fulfillmentPolicyId: "ship" },
    availableQuantity: 1,
    status: "PUBLISHED",
  };
  const nextInventory = ebayInventoryQuantityBody(inventory, 17);
  const nextOffer = ebayOfferQuantityBody(offer, 17);
  assert.equal(nextInventory.product.title, "Holiday diffuser");
  assert.deepEqual(nextInventory.product.imageUrls, ["https://example/a.jpg"]);
  assert.equal(nextInventory.availability.shipToLocationAvailability.quantity, 17);
  assert.equal(nextOffer.pricingSummary.price.value, "19.99");
  assert.equal(nextOffer.listingPolicies.fulfillmentPolicyId, "ship");
  assert.equal(nextOffer.availableQuantity, 17);
  assert.equal(nextOffer.offerId, undefined);
  assert.deepEqual(amazonQuantityPatch(17).patches[0].value[0], { fulfillment_channel_code: "DEFAULT", quantity: 17 });
  assert.equal(planChannelQuantity({ channel: "ebay", available: 1, listing: { status: "listed", quantity: 1 } }), null);
});

test("one minute of changes becomes one update per SKU", () => {
  const first = debounceQtyRow(null, 17, new Date("2026-10-30T12:00:00Z"));
  const second = debounceQtyRow({ ...first, status: "pending" }, 15, new Date("2026-10-30T12:00:20Z"));
  assert.equal(second.not_before, first.not_before);
  assert.equal(second.available_qty, 15);
  const later = debounceQtyRow({ ...second, status: "done" }, 12, new Date("2026-10-30T12:02:00Z"));
  assert.equal(later.available_qty, 12);
  assert.notEqual(later.not_before, first.not_before);
});

test("a sale of one from a stocked listing leaves the rest for sale", () => {
  assert.equal(saleLeavesStock({ qty_on_hand: 4, state: "available" }), true);
  assert.equal(saleLeavesStock({ qty_on_hand: 0, state: "available" }), false);
  assert.equal(saleLeavesStock({ qty_on_hand: 1, state: "sold" }), false);
});

test("Depop is a manual quantity flag", () => {
  const plan = planChannelQuantity({ channel: "depop", available: 17, listing: { status: "listed", quantity: 10, stale: true } });
  assert.equal(plan.op, "flag");
  assert.equal(plan.quantity, 17);
});
