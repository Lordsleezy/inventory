import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  consumeRate,
  decideUnit,
  includeInView,
  keysMatch,
  listingUrl,
  marketplaceBlocks,
  pageSkus,
  parseListingFeedQuery,
  photoSort,
  resetRateLimits,
  shapeUnit,
} from "./listing-feed.mjs";

const ready = {
  sku: "99735",
  state: "available",
  qty_on_hand: 1,
  ask_cents: 3999,
  is_test: false,
  title: "TRINITY Sliding Undersink Organizer",
  brand: "TRINITY",
  category: "Storage",
};

const clear = { photoCount: 1, sale: false, reservation: false, hold: false };

test("missing or wrong feed key is rejected without a length leak", () => {
  assert.equal(keysMatch("", "secret"), false);
  assert.equal(keysMatch("secret", ""), false);
  assert.equal(keysMatch("nope", "secret"), false);
  assert.equal(keysMatch("secret", "secret"), true);
  assert.equal(keysMatch("secret-extra", "secret"), false);
});

test("rugs stay eligible and appliances, mattresses, and the scooter do not", () => {
  assert.deepEqual(marketplaceBlocks({ title: "Safavieh area rug", category: "Rugs" }), []);
  assert.deepEqual(marketplaceBlocks({ title: "Outdoor carpet runner", category: "Rugs" }), []);
  assert.deepEqual(marketplaceBlocks({ title: "Samsung French-door refrigerator" }), ["fridge"]);
  assert.deepEqual(marketplaceBlocks({ title: "Compact fridge" }), ["fridge"]);
  assert.deepEqual(marketplaceBlocks({ category: "Dishwashers", title: "Bosch" }), ["dishwasher"]);
  assert.deepEqual(marketplaceBlocks({ title: "Queen mattress" }), ["mattress"]);
  assert.deepEqual(marketplaceBlocks({ title: "Queen mattress pad" }), []);
  assert.deepEqual(marketplaceBlocks({ title: "Memory foam mattress topper" }), []);
  assert.deepEqual(marketplaceBlocks({ title: "Waterproof mattress protector" }), []);
  assert.deepEqual(marketplaceBlocks({ title: "Box spring" }), ["mattress"]);
  assert.deepEqual(marketplaceBlocks({ sku: "11284", title: "Bike" }), ["scooter"]);
  assert.deepEqual(marketplaceBlocks({ title: "Segway hoverboard" }), ["scooter"]);
  assert.deepEqual(marketplaceBlocks({ title: "Upright freezer" }), []);

  const rug = decideUnit({ ...ready, title: "Safavieh area rug", category: "Rugs" }, clear);
  assert.equal(rug.eligible, true);
  assert.deepEqual(rug.reasons, []);

  const fridge = decideUnit({ ...ready, title: "Fridge" }, clear);
  assert.equal(fridge.available, true);
  assert.equal(fridge.eligible, false);
  assert.deepEqual(fridge.reasons, ["fridge"]);
});

test("sold, reserved, open sale, and missing photo or price are not eligible", () => {
  assert.equal(decideUnit({ ...ready, state: "sold" }, clear).available, false);
  assert.ok(decideUnit({ ...ready, state: "sold" }, clear).reasons.includes("sold"));
  assert.ok(decideUnit({ ...ready, state: "reserved" }, clear).reasons.includes("reserved"));
  const openSale = decideUnit(ready, { ...clear, sale: true });
  assert.equal(openSale.available, false);
  assert.ok(openSale.reasons.includes("sold"));
  assert.ok(openSale.reasons.includes("open_sale"));
  const held = decideUnit(ready, { ...clear, hold: true });
  assert.equal(held.available, false);
  assert.ok(held.reasons.includes("reserved"));
  const bare = decideUnit({ ...ready, ask_cents: 0 }, { ...clear, photoCount: 0 });
  assert.equal(bare.eligible, false);
  assert.ok(bare.reasons.includes("missing_photo"));
  assert.ok(bare.reasons.includes("missing_price"));
  assert.equal(includeInView(decideUnit(ready, clear), "available", 1), true);
  assert.equal(includeInView(decideUnit({ ...ready, state: "sold" }, clear), "available", 1), false);
  assert.equal(includeInView(bare, "photo-ready", 0), false);
  assert.equal(includeInView(decideUnit(ready, { ...clear, photoCount: 1 }), "all", 0), true);
});

test("query parsing accepts the feed filters and rejects junk", () => {
  const query = parseListingFeedQuery({
    view: "photo_ready",
    sku: "10001, 10002",
    category: "Rugs",
    since: "2026-10-01T00:00:00Z",
    limit: "10",
    cursor: "10000",
    eligible: "1",
  });
  assert.equal(query.view, "photo-ready");
  assert.deepEqual(query.skus, ["10001", "10002"]);
  assert.equal(query.eligibleOnly, true);
  assert.equal(query.limit, 10);
  assert.throws(() => parseListingFeedQuery({ view: "sold" }), /invalid_view/);
  assert.throws(() => parseListingFeedQuery({ sku: "abc" }), /invalid_sku/);
  assert.throws(() => parseListingFeedQuery({ since: "yesterday" }), /invalid_since/);
  assert.throws(() => parseListingFeedQuery({ limit: "500" }), /invalid_limit/);
  const check = parseListingFeedQuery({ check: "11548" });
  assert.equal(check.check, "11548");
  assert.deepEqual(check.skus, ["11548"]);
});

test("paging walks sku order and stops", () => {
  const first = pageSkus(["10003", "10001", "10002", "10002"], { limit: 2, cursor: null });
  assert.deepEqual(first.skus, ["10001", "10002"]);
  assert.equal(first.total, 3);
  assert.equal(first.next_cursor, "10002");
  const second = pageSkus(["10003", "10001", "10002"], { limit: 2, cursor: first.next_cursor });
  assert.deepEqual(second.skus, ["10003"]);
  assert.equal(second.next_cursor, null);
});

test("listing urls cover the channels Floor stores an id for", () => {
  assert.equal(listingUrl("ebay", "820244160755", "1"), "https://www.ebay.com/itm/820244160755");
  assert.equal(listingUrl("depop", "941352842", "1"), "https://www.depop.com/products/941352842/");
  assert.equal(listingUrl("amazon", "B00TEST123", "1"), "https://www.amazon.com/dp/B00TEST123");
  assert.equal(listingUrl("website", null, "99735"), "https://openboxindustries.com/item/99735");
  assert.equal(listingUrl("mercari", null, "1"), null);
  assert.equal(listingUrl("whatnot", "TGlzdGluZzoyMzk2NDk1NjQ1", "1"), null);
});

test("photos follow sort_order, then primary, then created time", () => {
  const rows = [
    { id: 2, sort_order: 1, is_primary: true, created_at: "2026-01-01T00:00:00Z" },
    { id: 1, sort_order: 0, is_primary: false, created_at: "2026-02-01T00:00:00Z" },
    { id: 3, sort_order: null, is_primary: false, created_at: "2026-01-01T00:00:00Z" },
  ];
  assert.deepEqual(rows.sort(photoSort).map((row) => row.id), [1, 2, 3]);
});

test("shaped unit uses the asking price as the Floor price and keeps the private path off the payload", () => {
  const unit = shapeUnit({
    ...ready,
    floor_cents: 2500,
    acquisition_cost_cents: 1000,
    msrp_cents: 8000,
    received_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
    listed_on: ["depop"],
    package_weight_lb: "4.50",
    dims_source: "verified",
  }, {
    photos: [{ id: 1, path: "secret/path.jpg", created_at: "2026-01-02T00:00:00Z", sort_order: 0, is_primary: true }],
    listings: [{ channel: "ebay", status: "listed", listing_id: "123", offer_id: "off", listed_at: "2026-03-01T00:00:00Z", ebay_account_id: "acc" }],
    accounts: new Map([["acc", { username: "ikonikdeals2026", role: "selling" }]]),
    onWebsite: true,
    signed: new Map([["secret/path.jpg", "https://signed.example/photo"]]),
    decision: { available: true, eligible: true, reasons: [] },
  });
  assert.equal(unit.floor_price_cents, 3999);
  assert.equal(unit.minimum_cents, 2500);
  assert.equal(unit.cost_cents, 1000);
  assert.equal(unit.retail_cents, 8000);
  assert.equal(unit.dimensions.package.weight_lb, 4.5);
  assert.equal(unit.dimensions.source, "verified");
  assert.equal(unit.photos[0].url, "https://signed.example/photo");
  assert.equal(JSON.stringify(unit).includes("secret/path"), false);
  assert.equal(unit.listings[0].ebay_account.username, "ikonikdeals2026");
  assert.equal(unit.listings[1].channel, "website");
  assert.equal(unit.quantity, 1);
});

test("successful calls are capped per window", () => {
  resetRateLimits();
  let last = null;
  for (let i = 0; i < 3; i += 1) last = consumeRate("ok:test", 2, 1_000);
  assert.equal(last.ok, false);
  assert.equal(consumeRate("ok:test", 2, 1_000 + 60_000).ok, true);
  resetRateLimits();
});

test("the feed function has no write calls", () => {
  const sources = [
    readFileSync(new URL("./listing-feed.mjs", import.meta.url), "utf8"),
    readFileSync(new URL("../functions/listing-feed.mjs", import.meta.url), "utf8"),
  ].join("\n").replace(/createHash\([^)]*\)\.update\(/g, "");
  assert.equal(/\.(insert|update|upsert|delete|remove|rpc)\s*\(/.test(sources), false);
});
