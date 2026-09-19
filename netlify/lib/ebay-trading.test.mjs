import assert from "node:assert/strict";
import test from "node:test";
import { xmlEsc, tradingConditionId, parseShippingServiceDetails, pickApplianceShipping } from "./ebay-trading.mjs";

test("xmlEsc encodes markup so Trading API XML stays well-formed", () => {
  assert.equal(xmlEsc(`A & B <C>`), "A &amp; B &lt;C&gt;");
});

test("eBay REST conditions map to Trading ConditionID", () => {
  assert.equal(tradingConditionId("NEW"), "1000");
  assert.equal(tradingConditionId("LIKE_NEW"), "1500");
  assert.equal(tradingConditionId("USED_GOOD"), "3000");
  assert.equal(tradingConditionId("FOR_PARTS_OR_NOT_WORKING"), "7000");
});

test("picks freight or local delivery from GeteBayDetails, never guessed pickup codes", () => {
  const xml = `
    <ShippingServiceDetails>
      <Description>Local Pickup</Description>
      <ShippingService>Pickup</ShippingService>
      <ValidForSellingFlow>true</ValidForSellingFlow>
      <ShippingCategory>PICKUP</ShippingCategory>
      <ServiceType>Flat</ServiceType>
    </ShippingServiceDetails>
    <ShippingServiceDetails>
      <Description>USPS Priority Mail</Description>
      <ShippingService>USPSPriority</ShippingService>
      <ValidForSellingFlow>true</ValidForSellingFlow>
      <ShippingCategory>EXPEDITED</ShippingCategory>
      <ServiceType>Flat</ServiceType>
    </ShippingServiceDetails>
    <ShippingServiceDetails>
      <Description>Freight</Description>
      <ShippingService>Freight</ShippingService>
      <ValidForSellingFlow>true</ValidForSellingFlow>
      <ShippingCategory>FREIGHT</ShippingCategory>
      <ServiceType>Flat</ServiceType>
    </ShippingServiceDetails>
    <ShippingServiceDetails>
      <Description>Local Delivery</Description>
      <ShippingService>ShippingMethodLocalDelivery</ShippingService>
      <ValidForSellingFlow>true</ValidForSellingFlow>
      <ShippingCategory>OTHER</ShippingCategory>
      <ServiceType>Flat</ServiceType>
    </ShippingServiceDetails>
  `;
  const rows = parseShippingServiceDetails(xml);
  const pick = pickApplianceShipping(rows);
  assert.equal(pick.shippingService, "Freight");
  assert.notEqual(pickApplianceShipping(rows.filter((r) => r.shippingCategory !== "FREIGHT")).shippingService, "Pickup");
  assert.equal(
    pickApplianceShipping(rows.filter((r) => r.shippingCategory !== "FREIGHT")).shippingService,
    "ShippingMethodLocalDelivery",
  );
});
