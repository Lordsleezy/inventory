import test from "node:test";
import assert from "node:assert/strict";
import { costcoByItemNumber, ebayEnrichFromIdentity } from "./costco-lookup.mjs";

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

test("ebayEnrichFromIdentity requires brand or description", async () => {
  const result = await ebayEnrichFromIdentity({});
  assert.equal(result.found, false);
  assert.equal(result.raw_error, "ebay_identity_required");
});
