import test from "node:test";
import assert from "node:assert/strict";
import { depopItemTitle, depopProductIds, emailPhotoUrls, matchDepopListing } from "./depop-email-match.mjs";

const backpack = {
  sku: "11352",
  listing_id: "941352842",
  title: "bagsmart travel backpack",
  ask_cents: 6374,
  photo_paths: ["store/11352/bagsmart-front.jpg"],
};
const twin = {
  sku: "11240",
  listing_id: "941100001",
  title: "Pokemon chaos rising blister pack",
  ask_cents: 1800,
  photo_paths: ["store/11240/pack-a.jpg"],
};
const twinB = {
  sku: "11241",
  listing_id: "941100002",
  title: "Pokemon chaos rising blister pack",
  ask_cents: 1800,
  photo_paths: ["store/11241/pack-b.jpg"],
};

test("a Depop product id in the email is one clear listing", () => {
  const html = '<a href="https://www.depop.com/products/bagsmart-travel-backpack-941352842/">view</a><img src="https://media-photos.depop.com/b1/941352842/1.jpg">';
  assert.deepEqual(depopProductIds(html), ["941352842"]);
  assert.equal(emailPhotoUrls(html, "").length, 2);
  const hit = matchDepopListing(
    { title: "something else", priceCents: 1999, urls: emailPhotoUrls(html, ""), productIds: depopProductIds(html) },
    [backpack, twin],
  );
  assert.equal(hit.sku, "11352");
  assert.equal(hit.via, "listing_id");
});

test("title plus price matches one Push-to-Depop row and refuses twins", () => {
  const title = depopItemTitle(
    "Your USPS shipping label and sale confirmation for @kay_lucha.",
    "You've made a sale!\nBagsmart travel backpack\nItem price $63.74\nShip to:\nPat\n1 Main St",
  );
  assert.equal(title, "Bagsmart travel backpack");
  const one = matchDepopListing({ title, priceCents: 6374, urls: [], productIds: [] }, [backpack, twin]);
  assert.equal(one.sku, "11352");
  assert.equal(one.via, "title_price");
  const ambiguous = matchDepopListing(
    { title: "Pokemon chaos rising blister pack", priceCents: 1800, urls: [], productIds: [] },
    [twin, twinB],
  );
  assert.equal(ambiguous, null);
});

test("shipping-label email extracts the item from Order details", () => {
  const title = depopItemTitle(
    "Your USPS shipping label and sale confirmation for @kay_lucha.",
    "You've made a sale!\nNow it's time to ship\nPrint a label\nOrder details\nimage Bagsmart travel backpack. Open box; see the...\n$19.99\nShip to",
  );
  assert.equal(title, "Bagsmart travel backpack. Open box; see the...");
});

test("a different price without a photo or listing id stays unmatched", () => {
  const hit = matchDepopListing(
    { title: "Bagsmart travel backpack", priceCents: 1999, urls: [], productIds: [] },
    [backpack],
  );
  assert.equal(hit, null);
});

test("the listing photo url plus the title is a clear hit when the sold price is an offer", () => {
  const urls = ["https://inventoryobi.netlify.app/photos/store/11352/bagsmart-front.jpg"];
  const hit = matchDepopListing(
    { title: "Bagsmart travel backpack", priceCents: 5000, urls, productIds: [] },
    [backpack, twin],
  );
  assert.equal(hit.sku, "11352");
  assert.match(hit.via, /photo/);
});
