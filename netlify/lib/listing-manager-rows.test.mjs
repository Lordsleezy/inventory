import assert from "node:assert/strict";
import test from "node:test";
import {
  amazonIsLive,
  amazonRowFromSearchItem,
  centsFromAmount,
  depopRowFromFloor,
  ebayRowFromActive,
  listingMatches,
  mergeEbayListings,
  tiktokIsLive,
  tiktokRowFromProduct,
} from "./listing-manager-rows.mjs";

test("trading price and available qty come from the ActiveList summary", () => {
  assert.equal(centsFromAmount("29.99"), 2999);
  const row = ebayRowFromActive(
    { id: "a1", username: "ikonikdeals2026", role: "selling" },
    { itemId: "111", title: "Lamp", sku: "100", currentPrice: "19.50", quantity: 2, quantitySold: 1, listingStatus: "Active" },
    { ask_cents: 1950, state: "available", title: "Lamp" },
  );
  assert.equal(row.price_cents, 1950);
  assert.equal(row.qty, 1);
  assert.equal(row.account, "ikonikdeals2026");
  assert.equal(row.editable, true);
  assert.equal(row.drift, null);
  assert.equal(row.url, "https://www.ebay.com/itm/111");
});

test("both eBay accounts stay in the list and Floor does not duplicate a live SKU or item id", () => {
  const selling = ebayRowFromActive(
    { id: "sell", username: "ikonikdeals2026", role: "selling" },
    { itemId: "111", sku: "100", title: "Lamp", currentPrice: "10.00", quantity: 1, quantitySold: 0 },
  );
  const orders = ebayRowFromActive(
    { id: "ord", username: "pgg124-5", role: "orders_only" },
    { itemId: "222", sku: "", title: "Chair", currentPrice: "40", quantity: 1, quantitySold: 0 },
  );
  assert.equal(orders.editable, false);
  const merged = mergeEbayListings(
    [selling, orders],
    [
      { sku: "100", listing_id: "999", status: "listed", ebay_account_id: "sell" },
      { sku: "300", listing_id: "222", status: "listed" },
      { sku: "400", listing_id: "444", status: "listed", ebay_account_id: "ord" },
    ],
    { 400: { title: "Fan", ask_cents: 800, state: "available" } },
    { ord: { id: "ord", username: "pgg124-5", role: "orders_only" } },
  );
  assert.deepEqual(merged.map((row) => row.sku || row.item_id), ["100", "222", "400"]);
  assert.equal(merged[2].account, "pgg124-5");
  assert.equal(merged[2].api, "floor");
  assert.equal(merged[2].title, "Fan");
});

test("Amazon search rows keep buyable offers and skip ended ones", () => {
  assert.equal(amazonIsLive({ summaries: [{ status: ["BUYABLE", "DISCOVERABLE"] }] }), true);
  assert.equal(amazonIsLive({ summaries: [{ status: ["DELETED"] }] }), false);
  const row = amazonRowFromSearchItem(
    {
      sku: "55",
      summaries: [{ itemName: "Mug", asin: "B000TEST", status: ["BUYABLE"] }],
      offers: [{ price: { amount: "12.00", currencyCode: "USD" } }],
      fulfillmentAvailability: [{ quantity: 1 }],
    },
    { ask_cents: 1500, state: "available", title: "Mug" },
    null,
    null,
  );
  assert.equal(row.price_cents, 1200);
  assert.equal(row.asin, "B000TEST");
  assert.equal(row.drift, "Amazon price ≠ Floor ask");
  assert.equal(listingMatches(row, "b000"), true);
  assert.equal(listingMatches(row, "missing"), false);
});

test("TikTok live products and Depop floor rows keep sku, price, and link", () => {
  assert.equal(tiktokIsLive("ACTIVATE"), true);
  assert.equal(tiktokIsLive("DELETED"), false);
  const tiktok = tiktokRowFromProduct(
    {
      id: "tt1",
      title: "Hat",
      status: "ACTIVATE",
      skus: [{ seller_sku: "77", price: { sale_price: "8.00" }, inventory: [{ quantity: 1 }] }],
    },
    { ask_cents: 800, state: "available" },
  );
  assert.equal(tiktok.sku, "77");
  assert.equal(tiktok.price_cents, 800);
  assert.equal(tiktok.editable, true);
  const depop = depopRowFromFloor({ sku: "88", listing_id: "abc123", status: "listed" }, { title: "Bag", ask_cents: 2500, state: "available" });
  assert.equal(depop.url, "https://www.depop.com/products/abc123/");
  assert.equal(depop.price_cents, 2500);
});
