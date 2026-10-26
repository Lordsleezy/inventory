import { test } from "node:test";
import assert from "node:assert/strict";
import { fulfillmentPath, ordersWithShipment, shipmentPatch } from "./ebay-shipment.mjs";

const shipped = { orderId: "A", orderPaymentStatus: "PAID", orderFulfillmentStatus: "FULFILLED", fulfillmentHrefs: ["https://api.ebay.com/sell/fulfillment/v1/order/A/shipping_fulfillment/F1"] };

test("only shipped, live orders are picked", () => {
  const orders = [
    shipped,
    { orderId: "B", orderFulfillmentStatus: "NOT_STARTED", fulfillmentHrefs: [] },
    { orderId: "C", orderPaymentStatus: "FULLY_REFUNDED", fulfillmentHrefs: ["https://x/y"] },
    { orderId: "D", cancelStatus: { cancelState: "CANCELED" }, fulfillmentHrefs: ["https://x/y"] },
    { orderFulfillmentStatus: "FULFILLED", fulfillmentHrefs: ["https://x/y"] },
  ];
  assert.deepEqual(ordersWithShipment(orders).map((o) => o.orderId), ["A"]);
});

test("fulfillment href becomes an API path", () => {
  assert.equal(fulfillmentPath(shipped), "/sell/fulfillment/v1/order/A/shipping_fulfillment/F1");
  assert.equal(fulfillmentPath({ fulfillmentHrefs: [] }), null);
});

test("shipment patch uses eBay's ship date and tracking", () => {
  const now = "2026-10-26T00:00:00.000Z";
  assert.deepEqual(shipmentPatch({ shippedDate: "2026-10-25T18:30:00.000Z", shipmentTrackingNumber: " 9400 ", shippingCarrierCode: "USPS" }, now),
    { shipped_at: "2026-10-25T18:30:00.000Z", tracking_number: "9400", carrier: "USPS" });
  assert.deepEqual(shipmentPatch({}, now), { shipped_at: now });
  assert.equal(shipmentPatch(null, now), null);
});
