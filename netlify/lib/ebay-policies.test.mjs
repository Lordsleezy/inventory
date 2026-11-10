import test from "node:test";
import assert from "node:assert/strict";
import { calculatedBuyerPaysBody } from "./ebay-policies.mjs";

test("buyer-pays calculated policy keeps Ground Advantage first", () => {
  const body = calculatedBuyerPaysBody("EBAY_US");
  const services = body.shippingOptions[0].shippingServices.map((row) => row.shippingServiceCode);
  assert.deepEqual(services, ["USPSParcel", "USPSPriority", "USPSExpressMail"]);
  assert.equal(body.handlingTime.value, 2);
  assert.equal(body.shippingOptions[0].shippingServices[0].freeShipping, false);
  assert.equal(body.shippingOptions[0].costType, "CALCULATED");
});
