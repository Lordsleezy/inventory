import test from "node:test";
import assert from "node:assert/strict";
import { descriptionHtml, pushEbayDescription } from "./ebay-description-sync.mjs";

function fakeSb({ body = "Line one.\n\nLine <two>", listing }) {
  const table = (rows) => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rows }) }), maybeSingle: async () => ({ data: rows }) }) }) }) });
  return { from: (name) => name === "units" ? table({ listing_body: body }) : table(listing) };
}

test("description html escapes and paragraphs", () => {
  assert.equal(descriptionHtml("A b.\n\nC <x>\nD"), "<p>A b.</p><p>C &lt;x&gt;<br>D</p>");
});

test("only the description changes on an Inventory API offer (price and promotions stay)", async () => {
  const calls = [];
  const offer = { offerId: "9", sku: "1", pricingSummary: { price: { value: "10.00" } }, listingPolicies: { fulfillmentPolicyId: "f" }, listingDescription: "old", status: "PUBLISHED", listing: { listingId: "8" } };
  const r = await pushEbayDescription("s", "1", {
    sb: fakeSb({ listing: { listing_id: "8", offer_id: "9", status: "listed" } }), account: { id: "a" },
    ebayFetch: async (_s, method, path, body) => { calls.push({ method, path, body }); return method === "GET" ? offer : {}; },
  });
  assert.equal(r.via, "offer");
  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put.body.listingDescription, "<p>Line one.</p><p>Line &lt;two&gt;</p>");
  assert.deepEqual(put.body.pricingSummary, offer.pricingSummary);
  assert.deepEqual(put.body.listingPolicies, offer.listingPolicies);
});

test("Trading listings are revised with the description only", async () => {
  let change;
  const r = await pushEbayDescription("s", "1", {
    sb: fakeSb({ listing: { listing_id: "820244217131", offer_id: null, status: "listed" } }), account: { id: "a" }, token: "t",
    revise: async (_t, c) => { change = c; },
  });
  assert.equal(r.via, "trading");
  assert.deepEqual(Object.keys(change).sort(), ["description", "itemId"]);
});

test("nothing is sent when the unit is not live on eBay", async () => {
  const r = await pushEbayDescription("s", "1", { sb: fakeSb({ listing: { listing_id: "8", offer_id: "9", status: "delisted" } }), account: { id: "a" },
    ebayFetch: async () => { throw new Error("must not call eBay"); } });
  assert.deepEqual(r, { updated: false, reason: "not_live_on_ebay" });
});
