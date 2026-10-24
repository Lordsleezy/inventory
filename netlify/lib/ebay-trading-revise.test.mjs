import assert from "node:assert/strict";
import test from "node:test";
import { tradingReviseItemXml } from "./ebay-trading.mjs";

test("trading revise sets price, title, photos, and specifics on the item id", () => {
  const xml = tradingReviseItemXml({
    itemId: "123456789012",
    price: 24.5,
    title: "Floor & Co",
    description: "Open box",
    conditionDescription: "Scratch",
    quantity: 1,
    pictureUrls: ["https://example.com/a.jpg", "not-a-url"],
    aspects: { Brand: ["Acme"] },
  });
  assert.match(xml, /<ItemID>123456789012<\/ItemID>/);
  assert.match(xml, /<StartPrice>24.50<\/StartPrice>/);
  assert.match(xml, /<Title>Floor &amp; Co<\/Title>/);
  assert.match(xml, /<PictureURL>https:\/\/example\.com\/a\.jpg<\/PictureURL>/);
  assert.doesNotMatch(xml, /not-a-url/);
  assert.match(xml, /<Name>Brand<\/Name><Value>Acme<\/Value>/);
  assert.doesNotMatch(xml, /SellerProfiles/);
});

test("trading revise refuses a non-numeric item id and an empty change", () => {
  assert.throws(() => tradingReviseItemXml({ itemId: "SKU-1", price: 10 }), /numeric item id/);
  assert.throws(() => tradingReviseItemXml({ itemId: "123" }), /nothing_to_revise/);
});
