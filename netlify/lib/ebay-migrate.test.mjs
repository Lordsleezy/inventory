import assert from "node:assert/strict";
import test from "node:test";
import { migrationBannedReason, describeMigrationPlan } from "./ebay-migrate-rules.mjs";
import { tradingItemBlockedReason, parseActiveListSummaries, parseTradingItem } from "./ebay-trading.mjs";
import { ebayListingAllowed, oauthScopesForRole, EBAY_LISTING_OAUTH_SCOPES } from "./ebay-env.mjs";

test("migration skips refrigerators, dishwashers, mattresses", () => {
  assert.match(migrationBannedReason({ title: "Samsung French Door Refrigerator 28 cu" }), /refrigerator|fridge/i);
  assert.match(migrationBannedReason({ title: "Bosch dishwasher stainless" }), /dishwasher/i);
  assert.match(migrationBannedReason({ title: "Queen mattress and box spring" }), /mattress|box spring/i);
  assert.equal(migrationBannedReason({ title: "Ninja blender", categoryName: "Small Kitchen Appliances" }), null);
});

test("migration skips eBay-prohibited alcohol/tobacco", () => {
  assert.match(migrationBannedReason({ title: "Hard seltzer variety pack" }, { title: "Hard seltzer" }), /prohibit/i);
});

test("tradingItemBlockedReason catches bids, offers, open orders", () => {
  assert.equal(tradingItemBlockedReason({ itemId: "1", bidCount: 2 }), "active_bids");
  assert.equal(tradingItemBlockedReason({ itemId: "1", bestOfferCount: 1 }), "active_best_offer");
  assert.equal(
    tradingItemBlockedReason({ itemId: "99", bidCount: 0, bestOfferCount: 0, quantitySold: 0, listingStatus: "Active" }, {
      openOrderItemIds: new Set(["99"]),
    }),
    "open_order_on_source",
  );
  assert.equal(
    tradingItemBlockedReason({ itemId: "1", bidCount: 0, bestOfferCount: 0, quantitySold: 0, listingStatus: "Active" }),
    null,
  );
});

test("parseActiveListSummaries reads GetMyeBaySelling ActiveList items", () => {
  const xml = `
  <ActiveList>
    <ItemArray>
      <Item>
        <ItemID>111</ItemID>
        <Title>Lamp</Title>
        <SKU>12345</SKU>
        <Quantity>1</Quantity>
        <SellingStatus><CurrentPrice>19.99</CurrentPrice><QuantitySold>0</QuantitySold><BidCount>0</BidCount><ListingStatus>Active</ListingStatus></SellingStatus>
        <ListingType>FixedPriceItem</ListingType>
      </Item>
    </ItemArray>
  </ActiveList>`;
  const rows = parseActiveListSummaries(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemId, "111");
  assert.equal(rows[0].sku, "12345");
  assert.equal(rows[0].currentPrice, "19.99");
});

test("parseTradingItem captures photos, specifics, and best offers", () => {
  const xml = `
  <Item>
    <ItemID>222</ItemID>
    <Title>Toaster</Title>
    <Description>Works</Description>
    <SKU>99999</SKU>
    <PrimaryCategory><CategoryID>20667</CategoryID><CategoryName>Toasters</CategoryName></PrimaryCategory>
    <ConditionID>3000</ConditionID>
    <SellingStatus><CurrentPrice>29.99</CurrentPrice><QuantitySold>0</QuantitySold><BidCount>0</BidCount><ListingStatus>Active</ListingStatus></SellingStatus>
    <BestOfferDetails><BestOfferCount>0</BestOfferCount><BestOfferEnabled>false</BestOfferEnabled></BestOfferDetails>
    <PictureDetails><PictureURL>https://i.ebayimg.com/a.jpg</PictureURL><PictureURL>https://i.ebayimg.com/b.jpg</PictureURL></PictureDetails>
    <ItemSpecifics>
      <NameValueList><Name>Brand</Name><Value>Cuisinart</Value></NameValueList>
      <NameValueList><Name>Color</Name><Value>Silver</Value></NameValueList>
    </ItemSpecifics>
    <Quantity>1</Quantity>
  </Item>`;
  const item = parseTradingItem(xml);
  assert.equal(item.itemId, "222");
  assert.equal(item.imageUrls.length, 2);
  assert.equal(item.aspects.Brand[0], "Cuisinart");
  assert.equal(item.price, "29.99");
});

test("selling account scopes include inventory; listingAllowed honors role", () => {
  assert.match(oauthScopesForRole("selling"), /sell\.inventory/);
  assert.equal(oauthScopesForRole("selling"), EBAY_LISTING_OAUTH_SCOPES);
  assert.equal(ebayListingAllowed({ role: "selling", status: "connected" }), true);
  assert.equal(ebayListingAllowed({ role: "orders_only", status: "connected" }), false);
});

test("describeMigrationPlan documents end-then-create and skip rules", () => {
  const plan = describeMigrationPlan();
  assert.ok(plan.steps.some((s) => /EndItem/i.test(s)));
  assert.ok(plan.skipRules.some((s) => /refrigerator|fridge/i.test(s)));
});
