import assert from "node:assert/strict";
import test from "node:test";
import {
  appendClearanceFooter,
  brandsMatch,
  clearanceCondition,
  colorsConflict,
  damageText,
  identifiersFrom,
  isCollectible,
  packsConflict,
  photoDecision,
  pickCatalogProduct,
  reviseStandardsXml,
  withCatalogMainPhoto,
  CLEARANCE_FOOTER_MARK,
} from "./ebay-listing-standards.mjs";

const OPEN = [
  { conditionId: "1000", name: "New" },
  { conditionId: "1500", name: "Open box" },
  { conditionId: "3000", name: "Used" },
];

test("footer is small, exact, and added once", () => {
  const once = appendClearanceFooter("Features of the lamp.\n\n99105");
  assert.equal(once.includes(CLEARANCE_FOOTER_MARK), true);
  assert.match(once, /font-size:12px/);
  assert.equal(appendClearanceFooter(once), once);
  assert.equal(once.startsWith("Features of the lamp."), true);
  assert.equal((once.match(/Open-box clearance item/g) || []).length, 1);
});

test("collectibles are recognized and ordinary goods are not", () => {
  assert.equal(isCollectible({ title: "Pokemon Charizard holo" }), true);
  assert.equal(isCollectible({ title: "Sony WH-1000XM5 headphones", category: "Headphones" }), false);
  assert.equal(isCollectible({ is_collectible: true, title: "Mug" }), true);
  assert.equal(isCollectible({ title: "Fleetwood Mac Rumours vinyl LP" }), true);
});

test("open box is preferred and new other is the fallback", () => {
  assert.equal(clearanceCondition(OPEN).reason, "open_box");
  assert.equal(clearanceCondition(OPEN).conditionId, "1500");
  const other = clearanceCondition([
    { conditionId: "1000", name: "New" },
    { conditionId: "1500", name: "New other (see details)" },
    { conditionId: "3000", name: "Pre-owned" },
  ]);
  assert.equal(other.reason, "new_other");
  assert.equal(other.fallback, true);
  assert.equal(clearanceCondition([{ conditionId: "1000", name: "New" }, { conditionId: "3000", name: "Used" }]), null);
  const tagged = clearanceCondition(
    [
      { conditionId: "1000", name: "New with tags" },
      { conditionId: "1500", name: "New without tags" },
      { conditionId: "1750", name: "New with defects" },
      { conditionId: "3000", name: "Pre-owned" },
    ],
    "New",
  );
  assert.equal(tagged.conditionId, "1500");
  assert.equal(tagged.reason, "new");
});

test("catalog pick requires the same UPC or the same brand and model", () => {
  const products = [
    { epid: "1", title: "Other", brand: "Sony", mpn: "WH-1000XM4", gtin: ["012345678905"], image: { imageUrl: "https://i.ebayimg.com/a.jpg" } },
    { epid: "2", title: "Right", brand: "Sony", mpn: "WH-1000XM5", gtin: ["887276357386"], image: { imageUrl: "https://i.ebayimg.com/b.jpg" } },
  ];
  assert.equal(pickCatalogProduct(products, { gtin: "887276357386" }).product.epid, "2");
  assert.equal(pickCatalogProduct(products, { brand: "Sony", modelCode: "WH1000XM4" }).product.epid, "1");
  assert.equal(pickCatalogProduct(products, { brand: "Sony", modelCode: "WH1000XM3" }).ok, false);
  assert.equal(pickCatalogProduct(products, { gtin: "000000000000" }).reason, "upc_not_in_catalog");
});

test("a similar model or a different color is not a photo match", () => {
  const product = { epid: "2", images: ["https://i.ebayimg.com/b.jpg"], title: "Sony WH-1000XM5 Black" };
  const visual = { same: true, sameColor: true, samePack: true, damage: false };
  assert.equal(photoDecision({
    product, ourText: "Sony WH-1000XM5 Silver", catalogText: "Sony WH-1000XM5 Black", visual,
  }).reason, "color_mismatch");
  assert.equal(photoDecision({
    product, ourText: "2 pack soap", catalogText: "6 pack soap", visual,
  }).reason, "pack_size_mismatch");
  assert.equal(photoDecision({
    product, ourText: "Sony WH-1000XM5 Black", catalogText: "Sony WH-1000XM5 Black", visual: { same: false, sameColor: true, samePack: true, damage: false },
  }).reason, "visual_not_confirmed");
  assert.equal(photoDecision({
    product, ourText: "Sony WH-1000XM5 Black", catalogText: "Sony WH-1000XM5 Black", visual, collectible: true,
  }).reason, "collectible");
  const ok = photoDecision({
    product, ourText: "Sony WH-1000XM5 Black", catalogText: "Sony WH-1000XM5 Black", visual,
  });
  assert.equal(ok.apply, true);
});

test("catalog photo stays first and a real photo stays second", () => {
  const mixed = withCatalogMainPhoto(["https://ours.example/1.jpg", "https://ours.example/2.jpg"], ["https://i.ebayimg.com/cat.jpg"]);
  assert.deepEqual(mixed.urls.slice(0, 2), ["https://i.ebayimg.com/cat.jpg", "https://ours.example/1.jpg"]);
  assert.equal(withCatalogMainPhoto([], ["https://i.ebayimg.com/only.jpg"]).ok, false);
  assert.equal(withCatalogMainPhoto([], ["https://i.ebayimg.com/a.jpg", "https://i.ebayimg.com/b.jpg"]).reason, "two_catalog_photos");
});

test("damage notes and missing identifiers skip photos", () => {
  assert.equal(damageText({ title: "Scratch resistant pan" }), false);
  assert.equal(damageText({ title: "Dented kettle" }), true);
  assert.equal(identifiersFrom({ upc: "887276357386", brand: "Sony", model: "XM" }).model, "");
  assert.equal(identifiersFrom({ aspects: { UPC: "887276357386", Brand: "Sony", MPN: "WH-1000XM5" } }).modelCode, "WH1000XM5");
  assert.equal(brandsMatch("Sony", "Sony Corporation"), true);
  assert.equal(brandsMatch("Sony", "Panasonic"), false);
  assert.equal(colorsConflict("black headphones", "black headphones"), false);
  assert.equal(packsConflict("single", "one item"), false);
});

test("a standards revise cannot carry price, title, quantity, shipping, or category", () => {
  const xml = reviseStandardsXml({
    itemId: "123",
    description: "Body",
    conditionId: "1500",
    pictureUrls: ["https://i.ebayimg.com/a.jpg"],
  });
  assert.match(xml, /<ItemID>123<\/ItemID>/);
  assert.match(xml, /<ConditionID>1500<\/ConditionID>/);
  assert.doesNotMatch(xml, /<Title|<StartPrice|<Quantity|<PrimaryCategory|<ShippingDetails|<SellerProfiles/);
});
