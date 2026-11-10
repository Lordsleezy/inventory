import assert from "node:assert/strict";
import test from "node:test";
import { xmlEsc, tradingConditionId, parseShippingServiceDetails, pickApplianceShipping, parseTradingOrders, tradingOrderIsSale, tradingOrderToIngest, attachListingSku, tradingPackageReviseXml } from "./ebay-trading.mjs";

test("a package revise sends dimensions and weight only", () => {
  const xml = tradingPackageReviseXml({ itemId: "820244179489", lengthIn: 12, widthIn: 10, heightIn: 4, weightLb: 8 });
  assert.match(xml, /<ItemID>820244179489<\/ItemID>/);
  assert.match(xml, /<PackageLength>12<\/PackageLength>/);
  assert.match(xml, /<PackageWidth>10<\/PackageWidth>/);
  assert.match(xml, /<PackageDepth>4<\/PackageDepth>/);
  assert.match(xml, /<WeightMajor>8<\/WeightMajor>/);
  assert.match(xml, /<WeightMinor>0<\/WeightMinor>/);
  assert.equal(xml.includes("StartPrice"), false);
  assert.equal(xml.includes("Title"), false);
  assert.equal(xml.includes("SellerProfiles"), false);
  assert.equal(xml.includes("Description"), false);
  assert.equal(xml.includes("ReturnPolicy"), false);
  const withPolicy = tradingPackageReviseXml({
    itemId: "820249925445",
    lengthIn: 12,
    widthIn: 10,
    heightIn: 6,
    weightLb: 2,
    fulfillmentPolicyId: "new-policy",
    paymentPolicyId: "267755794017",
    returnPolicyId: "267755795017",
  });
  assert.match(withPolicy, /<ShippingProfileID>new-policy<\/ShippingProfileID>/);
  assert.match(withPolicy, /<PaymentProfileID>267755794017<\/PaymentProfileID>/);
  assert.equal(withPolicy.includes("StartPrice"), false);
});

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

const unpaidBin = `
<Order>
  <OrderID>110590742623-10000013598610</OrderID>
  <OrderStatus>Active</OrderStatus>
  <AmountPaid currencyID="USD">0.0</AmountPaid>
  <CheckoutStatus><Status>Incomplete</Status><PaymentMethod>None</PaymentMethod></CheckoutStatus>
  <CancelStatus>NotApplicable</CancelStatus>
  <Total currencyID="USD">499.0</Total>
  <TransactionArray><Transaction>
    <Item><ItemID>110590742623</ItemID><SKU>11150</SKU></Item>
    <QuantityPurchased>1</QuantityPurchased>
    <TransactionPrice currencyID="USD">499.0</TransactionPrice>
  </Transaction></TransactionArray>
</Order>`;

const sandboxSoldUnpaidXml = `
<Order>
  <OrderID>110590746616-10000013654610</OrderID>
  <OrderStatus>Active</OrderStatus>
  <AmountPaid currencyID="USD">0.0</AmountPaid>
  <CheckoutStatus><Status>Incomplete</Status><PaymentMethod>None</PaymentMethod></CheckoutStatus>
  <CancelStatus>NotApplicable</CancelStatus>
  <Total currencyID="USD">199.0</Total>
  <TransactionArray><Transaction>
    <Item><ItemID>110590746616</ItemID><SKU>11155</SKU></Item>
    <QuantityPurchased>1</QuantityPurchased>
    <TransactionPrice currencyID="USD">199.0</TransactionPrice>
  </Transaction></TransactionArray>
</Order>`;

const paidXml = `
<Order>
  <OrderID>12-345</OrderID>
  <OrderStatus>Completed</OrderStatus>
  <AmountPaid currencyID="USD">199.0</AmountPaid>
  <PaidTime>2026-09-19T19:40:00.000Z</PaidTime>
  <CheckoutStatus><Status>Complete</Status></CheckoutStatus>
  <CancelStatus>NotApplicable</CancelStatus>
  <Total currencyID="USD">199.0</Total>
  <TransactionArray><Transaction>
    <Item><SKU>11156</SKU></Item>
    <QuantityPurchased>1</QuantityPurchased>
    <TransactionPrice currencyID="USD">199.0</TransactionPrice>
  </Transaction></TransactionArray>
</Order>`;

test("unpaid BIN with no listing soldQuantity is not a Floor sale", () => {
  const [order] = parseTradingOrders(unpaidBin);
  assert.equal(order.sku, "11150");
  assert.equal(tradingOrderIsSale(order, { 11150: 0 }), false);
});

test("soldQuantity cannot turn an unpaid order into a sale", () => {
  const [order] = parseTradingOrders(sandboxSoldUnpaidXml);
  assert.equal(tradingOrderIsSale(order, {}), false);
  assert.equal(tradingOrderIsSale(order, { 11155: 1 }), false);
  assert.equal(tradingOrderToIngest(order).orderId, "110590746616-10000013654610");
  assert.equal(tradingOrderToIngest(order).pricingSummary.total.value, "199.0");
});

test("Trading order with ItemID and no SKU maps onto the Floor listing", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Order>
    <OrderID>18-15399-00001</OrderID>
    <OrderStatus>Completed</OrderStatus>
    <AmountPaid currencyID="USD">37.99</AmountPaid>
    <PaidTime>2026-10-21T18:00:00.000Z</PaidTime>
    <CheckoutStatus><Status>Complete</Status></CheckoutStatus>
    <CancelStatus>NotApplicable</CancelStatus>
    <Total currencyID="USD">37.99</Total>
    <TransactionArray><Transaction>
      <Item><ItemID>820244277561</ItemID></Item>
      <QuantityPurchased>1</QuantityPurchased>
      <TransactionPrice currencyID="USD">37.99</TransactionPrice>
    </Transaction></TransactionArray>
  </Order>
</GetOrdersResponse>`;
  const [order] = parseTradingOrders(xml);
  assert.equal(order.sku, "");
  assert.equal(tradingOrderIsSale(order), false);
  const mapped = attachListingSku(order, new Map([["820244277561", "11352"]]));
  assert.equal(mapped.sku, "11352");
  assert.equal(tradingOrderIsSale(mapped), true);
  assert.equal(tradingOrderToIngest(mapped).lineItems[0].sku, "11352");
});

test("paid Trading orders ingest even without soldQuantity map", () => {
  const [order] = parseTradingOrders(paidXml);
  assert.equal(tradingOrderIsSale(order), true);
  assert.equal(tradingOrderToIngest(order).pricingSummary.total.value, "199.0");
});

