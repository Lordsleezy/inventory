import assert from "node:assert/strict";
import test from "node:test";
import {
  migrationBannedReason,
  describeMigrationPlan,
  isVerificationHiddenListingError,
  isListingRemovedPolicyError,
  isEndAlreadyEndedError,
  isSourceAlreadyEndedStatus,
  itemFromActiveListSummary,
  tallyMigrationSummary,
  emptyMigrationSummary,
  clipMigrationTitle,
  migrationConditionId,
  migrationConditionFallbacks,
  migrationWeightLb,
  migrationPackageDims,
  MIGRATION_CREATE_BUILD,
  sanitizeMigrationAspects,
} from "./ebay-migrate-rules.mjs";
import { tradingItemBlockedReason, parseActiveListSummaries, parseTradingItem } from "./ebay-trading.mjs";
import { ebayListingAllowed, oauthScopesForRole, EBAY_LISTING_OAUTH_SCOPES } from "./ebay-env.mjs";

test("migration skips refrigerators, dishwashers, mattresses", () => {
  assert.match(migrationBannedReason({ title: "Samsung French Door Refrigerator 28 cu" }), /refrigerator|fridge/i);
  assert.match(migrationBannedReason({ title: "Bosch dishwasher stainless" }), /dishwasher/i);
  assert.match(migrationBannedReason({ title: "Queen mattress and box spring" }), /mattress|box spring/i);
  assert.equal(migrationBannedReason({ title: "Ninja blender", categoryName: "Small Kitchen Appliances" }), null);
});

test("Floor unit title beats a bogus eBay fridge category for ban checks", () => {
  assert.equal(
    migrationBannedReason(
      { title: "Signed Shirt Brett Favre", categoryName: "Refrigerators" },
      { title: "Signed shirt Brett Favre sign tank top framed", category: "Sports memorabilia", sku: "11272" },
    ),
    null,
  );
  // Draft-backed context when units.title is empty / Uncategorized.
  assert.equal(
    migrationBannedReason(
      { title: "Signed Shirt Brett Favre", categoryName: "Refrigerators" },
      { title: "Signed shirt Brett Favre sign tank top framed", category: "", sku: "11272" },
    ),
    null,
  );
});

test("verification-hidden GetItem errors are detected", () => {
  assert.equal(
    isVerificationHiddenListingError(
      "This listing has a policy violation. It&apos;s hidden until you can fix it. (See email notice for more info.)",
    ),
    true,
  );
  assert.equal(isVerificationHiddenListingError("Item not found"), false);
  assert.equal(
    isListingRemovedPolicyError("This listing has been removed for a policy violation. Listing removed for policy violation."),
    true,
  );
  assert.equal(
    isListingRemovedPolicyError(
      "This listing has a policy violation. It&apos;s hidden until you can fix it.",
    ),
    false,
  );
});

test("tallyMigrationSummary matches item outcomes (not empty zeros)", () => {
  const summary = tallyMigrationSummary([
    { outcome: "will_move" },
    { outcome: "will_move" },
    { outcome: "skipped" },
    { outcome: "failed" },
  ]);
  assert.deepEqual(summary, { moved: 0, skipped: 1, failed: 1, will_move: 2, total: 4 });
  assert.deepEqual(emptyMigrationSummary().total, 0);
});

test("itemFromActiveListSummary marks verificationHidden for enrichment path", () => {
  const item = itemFromActiveListSummary({
    itemId: "123",
    title: "Lamp",
    sku: "11111",
    currentPrice: "19.99",
    quantity: 1,
    quantitySold: 0,
    bidCount: 0,
    categoryId: "20667",
    imageUrls: ["https://i.ebayimg.com/a.jpg"],
  });
  assert.equal(item.verificationHidden, true);
  assert.equal(item.itemId, "123");
  assert.equal(item.imageUrls.length, 1);
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
        <PrimaryCategory><CategoryID>20667</CategoryID><CategoryName>Lamps</CategoryName></PrimaryCategory>
        <PictureDetails><GalleryURL>https://i.ebayimg.com/g.jpg</GalleryURL><PictureURL>https://i.ebayimg.com/a.jpg</PictureURL></PictureDetails>
        <SellingStatus><CurrentPrice>19.99</CurrentPrice><QuantitySold>0</QuantitySold><BidCount>0</BidCount><ListingStatus>Active</ListingStatus></SellingStatus>
        <ListingType>FixedPriceItem</ListingType>
      </Item>
    </ItemArray>
    <PaginationResult><TotalNumberOfPages>2</TotalNumberOfPages><TotalNumberOfEntries>201</TotalNumberOfEntries></PaginationResult>
  </ActiveList>`;
  const rows = parseActiveListSummaries(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemId, "111");
  assert.equal(rows[0].sku, "12345");
  assert.equal(rows[0].currentPrice, "19.99");
  assert.equal(rows[0].categoryId, "20667");
  assert.equal(rows[0].imageUrls[0], "https://i.ebayimg.com/g.jpg");
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

test("clipMigrationTitle enforces eBay 80-char limit", () => {
  const long = "A".repeat(90);
  assert.equal(clipMigrationTitle(long).length, 80);
  assert.ok(clipMigrationTitle(long).endsWith("..."));
  assert.equal(clipMigrationTitle("Short title"), "Short title");
});

test("migration create helpers default weight and sanitize bad MPN", () => {
  assert.equal(migrationWeightLb(null, null), 1);
  assert.equal(migrationWeightLb({ package_weight_lb: 2.5 }, null), 2.5);
  assert.deepEqual(migrationPackageDims(null, null), { lengthIn: 12, widthIn: 9, heightIn: 3 });
  assert.equal(migrationConditionId("USED_EXCELLENT"), "3000");
  assert.equal(migrationConditionId("3000"), "3000");
  assert.ok(migrationConditionFallbacks("3000").includes("1000"));
  assert.equal(isEndAlreadyEndedError("The auction has already been closed."), true);
  assert.equal(isSourceAlreadyEndedStatus("listing_status_completed"), true);
  assert.ok(MIGRATION_CREATE_BUILD >= 2);
  const aspects = sanitizeMigrationAspects(
    { MPN: ["bowman 1989 official complete set sealed"], Brand: [] },
    { brand: "Topps", model: "1989" },
    { categoryName: "Sealed Trading Card Boxes" },
  );
  assert.equal(aspects.Brand[0], "Topps");
  assert.equal(aspects.MPN[0], "Does not apply");
  assert.equal(aspects.Type[0], "Sealed Trading Card Boxes");
});
