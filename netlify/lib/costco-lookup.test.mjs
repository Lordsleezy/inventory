import test from "node:test";
import assert from "node:assert/strict";
import { costcoByItemNumber, costcoByItemSearch, ebayEnrichFromIdentity } from "./costco-lookup.mjs";

test("costcoByItemNumber returns structured miss when fetch is blocked", async () => {
  const result = await costcoByItemNumber("1806358", {
    fetchImpl: async () => ({
      res: { status: 429, url: "https://www.costco.com/p/-/1806358" },
      text: "rate limited",
    }),
  });
  assert.equal(result.found, false);
  assert.equal(result.raw_error, "costco_rate_limited");
  assert.equal(result.item_number, "1806358");
});

test("costcoByItemNumber parses title and manufacturer UPC from HTML", async () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Puma Unlimited Backpack" />
      <meta property="og:image" content="https://example.com/puma.jpg" />
      <script type="application/ld+json">{"brand":"PUMA","upc":"019312345678"}</script>
    </head></html>`;
  const result = await costcoByItemNumber("2027861", {
    fetchImpl: async () => ({ res: { status: 200, url: "https://www.costco.com/p/-/2027861" }, text: html }),
  });
  assert.equal(result.found, true);
  assert.equal(result.title, "Puma Unlimited Backpack");
  assert.equal(result.manufacturer_upc, "019312345678");
  assert.deepEqual(result.images, ["https://example.com/puma.jpg"]);
});

test("costco page gallery drops site chrome and keeps the product shot", async () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Disney Halloween Village, 12-piece Set" />
      <meta property="og:image" content="https://gdx-assets.costco.com/adobe/assets/urn:aaid:aem:abc/as/4201007459_en.png?width=80&amp;height=80" />
    </head>
    <img src="https://gdx-assets.costco.com/adobe/assets/urn:aaid:aem:logo/as/costco-logo.png" />
    <img src="https://gdx-assets.costco.com/adobe/assets/urn:aaid:aem:faq/as/instacart-logo.png" />
    </html>`;
  const result = await costcoByItemNumber("1851532", {
    fetchImpl: async () => ({ res: { status: 200, url: "https://www.costco.com/p/-/disney-halloween-village-12-piece-set/4201007459" }, text: html }),
  });
  assert.deepEqual(result.images, ["https://gdx-assets.costco.com/adobe/assets/urn:aaid:aem:abc/as/4201007459_en.png"]);
});

test("item search opens the page whose sku is that item number", async () => {
  const search = `<a href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.costco.com/p/-/other-set/111")}">other</a>
    <a href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://www.costco.com/p/-/disney-halloween-village-12-piece-set/4201007459")}">this</a>`;
  const product = `<html><head>
      <meta property="og:title" content="Disney Halloween Village, 12-piece Set" />
      <meta property="og:image" content="https://gdx-assets.costco.com/adobe/assets/urn:aaid:aem:abc/as/4201007459_en.png?width=80" />
    </head><script>{"sku":"1851532"}</script></html>`;
  const result = await costcoByItemSearch("1851532", {
    fetchImpl: async (url) => url.includes("duckduckgo")
      ? { res: { status: 200, url }, text: search }
      : { res: { status: 200, url }, text: url.endsWith("/111") ? "<html></html>" : product },
  });
  assert.equal(result.found, true);
  assert.equal(result.item_number, "1851532");
  assert.deepEqual(result.images, ["https://gdx-assets.costco.com/adobe/assets/urn:aaid:aem:abc/as/4201007459_en.png"]);
});

test("ebayEnrichFromIdentity requires brand or description", async () => {
  const result = await ebayEnrichFromIdentity({});
  assert.equal(result.found, false);
  assert.equal(result.raw_error, "ebay_identity_required");
});
