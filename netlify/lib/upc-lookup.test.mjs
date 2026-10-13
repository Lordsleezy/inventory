import test from "node:test";
import assert from "node:assert/strict";
import { lookupUpc, mergeLookup, parseUpcitemdbDimension, parseUpcitemdbWeight, upcitemdbLookup } from "./upc-lookup.mjs";
import { parseCatalogItem, pickLargestImages } from "./amazon.mjs";

const catalogItem = {
  asin: "B0TESTASIN",
  summaries: [{ marketplaceId: "ATVPDKIKX0DER", itemName: "Acme Widget Pro", brand: "Acme", modelNumber: "WP-100", browseClassification: { displayName: "Gadgets" } }],
  attributes: {
    bullet_point: [{ value: "Fast", marketplace_id: "ATVPDKIKX0DER" }, { value: "Light", marketplace_id: "ATVPDKIKX0DER" }],
    product_description: [{ value: "A widget.", marketplace_id: "ATVPDKIKX0DER" }],
  },
  dimensions: [
    {
      marketplaceId: "ATVPDKIKX0DER",
      package: { length: { unit: "centimeters", value: 25.4 }, width: { unit: "inches", value: 5 }, height: { unit: "inches", value: 2 }, weight: { unit: "ounces", value: 24 } },
    },
  ],
  images: [
    {
      marketplaceId: "ATVPDKIKX0DER",
      images: [
        { variant: "MAIN", link: "small.jpg", width: 100, height: 100 },
        { variant: "MAIN", link: "big.jpg", width: 1000, height: 1000 },
        { variant: "PT01", link: "pt.jpg", width: 500, height: 500 },
      ],
    },
  ],
  productTypes: [{ marketplaceId: "ATVPDKIKX0DER", productType: "CONSUMER_ELECTRONICS" }],
};

test("parseCatalogItem converts units and picks largest images", () => {
  const p = parseCatalogItem(catalogItem);
  assert.equal(p.title, "Acme Widget Pro");
  assert.equal(p.model, "WP-100");
  assert.deepEqual(p.features, ["Fast", "Light"]);
  assert.deepEqual(p.package, { length_in: 10, width_in: 5, height_in: 2, weight_lb: 1.5 });
  assert.deepEqual(p.images, ["big.jpg", "pt.jpg"]);
  assert.equal(p.product_type, "CONSUMER_ELECTRONICS");
  assert.deepEqual(pickLargestImages([]), []);
});

test("upcitemdb dimension/weight parsing refuses to guess", () => {
  assert.deepEqual(parseUpcitemdbDimension("10 x 5 x 2 inches"), { length_in: 10, width_in: 5, height_in: 2 });
  assert.equal(parseUpcitemdbDimension("10 x 5 x 2").length_in, null);
  assert.equal(parseUpcitemdbWeight("24 Ounces"), 1.5);
  assert.equal(parseUpcitemdbWeight("heavy"), null);
});

test("merge prefers amazon, fills gaps from upcitemdb, lists disagreements", () => {
  const amazon = { found: true, asin: "B0X", title: "Acme Widget", brand: "Acme", model: null, description: null, features: ["a"], package: { length_in: 10, width_in: null, height_in: null, weight_lb: null }, images: [], price_cents: null };
  const upc = { found: true, title: "ACME widget ", brand: "Acme Corp", model: "M1", description: "d", package: { length_in: 10, width_in: 4, height_in: 3, weight_lb: 2 }, images: ["u.jpg"], price_cents: 5000, price_source: "upcitemdb_new_offers_median", price_as_of: "2026-10-01T00:00:00.000Z" };
  const { merged, fieldCoverage } = mergeLookup(amazon, upc);
  assert.equal(merged.title, "Acme Widget");
  assert.equal(merged.model, "M1");
  assert.equal(merged.retail_cents, 5000);
  assert.deepEqual(merged.package, { length_in: 10, width_in: 4, height_in: 3, weight_lb: 2 });
  assert.equal(fieldCoverage.package, "mixed");
  assert.equal(fieldCoverage.model, "upcitemdb");
  assert.equal(fieldCoverage.title, "amazon");
  assert.equal(fieldCoverage.images, "upcitemdb");
  assert.deepEqual(merged.disagreements.map((d) => d.field), ["brand"]);
});

function fakeSb(store = new Map()) {
  return {
    store,
    from() {
      return {
        select: () => ({ eq: (_c, v) => ({ maybeSingle: async () => ({ data: store.get(v) || null, error: null }) }) }),
        upsert: async (row) => {
          store.set(row.gtin14, row);
          return { error: null };
        },
      };
    },
  };
}

test("lookupUpc caches and skips external calls on hit; force refetches", async () => {
  let amazonCalls = 0;
  let upcCalls = 0;
  const sb = fakeSb();
  const deps = {
    sb,
    catalogByIdentifier: async () => {
      amazonCalls++;
      return { found: true, item: parseCatalogItem(catalogItem), alternatives: [] };
    },
    priceByAsin: async () => ({ price_cents: 4999, source: "buybox", as_of: "2026-10-13T00:00:00.000Z" }),
    upcitemdb: async () => {
      upcCalls++;
      return { found: false };
    },
    ebayComps: async () => null,
  };
  const first = await lookupUpc("s", "012345678905", { deps });
  assert.equal(first.cached, false);
  assert.equal(first.gtin.gtin14, "00012345678905");
  assert.equal(first.merged.retail_cents, 4999);
  assert.equal(first.merged.retail_source, "amazon_buybox");
  assert.equal(first.ebay, null);
  assert.equal(upcCalls, 0); // Amazon complete -> spare the UPCitemdb quota
  assert.equal(first.upcitemdb.skipped, "amazon_complete");
  const second = await lookupUpc("s", "012345678905", { deps });
  assert.equal(second.cached, true);
  assert.equal(amazonCalls, 1);
  await lookupUpc("s", "012345678905", { deps, force: true });
  assert.equal(amazonCalls, 2);
  await lookupUpc("s", "012345678905", { deps, force: true, compareUpcitemdb: true });
  assert.equal(upcCalls, 1);
});

test("transient errors are not cached; bad codes throw 400", async () => {
  const sb = fakeSb();
  const deps = {
    sb,
    catalogByIdentifier: async () => {
      throw new Error("amazon_spapi 429: slow down");
    },
    priceByAsin: async () => ({}),
    upcitemdb: async () => ({ found: false, raw_error: "upcitemdb_rate_limited" }),
    ebayComps: async () => null,
  };
  const r = await lookupUpc("s", "012345678905", { deps });
  assert.match(r.amazon.raw_error, /429/);
  assert.equal(sb.store.size, 0);
  await assert.rejects(() => lookupUpc("s", "123", { deps }), (e) => e.status === 400);
});

test("upcitemdb uses key headers only when UPCITEMDB_KEY is set", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return { ok: true, status: 200, headers: { get: () => "99" }, json: async () => ({ items: [{ title: "T", brand: "B", offers: [{ condition: "New", price: 10, updated_t: 1760000000 }] }] }) };
  };
  const trial = await upcitemdbLookup("012345678905", { fetchImpl, key: "" });
  assert.match(seen[0].url, /\/prod\/trial\/lookup\?upc=/);
  assert.equal(seen[0].headers.user_key, undefined);
  assert.equal(trial.price_cents, 1000);
  await upcitemdbLookup("012345678905", { fetchImpl, key: "abc" });
  assert.equal(seen[1].headers.user_key, "abc");
  assert.equal(seen[1].headers.key_type, "3scale");
});
