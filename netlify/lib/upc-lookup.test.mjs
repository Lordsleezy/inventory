import test from "node:test";
import assert from "node:assert/strict";
import { lookupUpc, mergeLookup, parseUpcitemdbDimension, parseUpcitemdbWeight, upcitemdbLookup } from "./upc-lookup.mjs";
import {
  amazonNeverListReason,
  catalogIdentifierMatches,
  extractCatalogAspects,
  formatAspectsLine,
  itemSpecificsFromLookup,
  parseCatalogItem,
  pickLargestImages,
  usableModelNumber,
  variantFromTitle,
} from "./amazon.mjs";
import { filterCategoryOptions, matchReceiveCategory } from "../../shared/receive-category.mjs";

const catalogItem = {
  asin: "B0TESTASIN",
  summaries: [{ marketplaceId: "ATVPDKIKX0DER", itemName: "Acme Widget Pro", brand: "Acme", modelNumber: "WP-100", browseClassification: { displayName: "Gadgets" } }],
  attributes: {
    bullet_point: [{ value: "Fast", marketplace_id: "ATVPDKIKX0DER" }, { value: "Light", marketplace_id: "ATVPDKIKX0DER" }],
    product_description: [{ value: "A widget.", marketplace_id: "ATVPDKIKX0DER" }],
    flavor: [{ value: "Berry Blast", marketplace_id: "ATVPDKIKX0DER" }],
    item_form: [{ value: "Gummy", marketplace_id: "ATVPDKIKX0DER" }],
    product_benefit: [{ value: "Gut Health", marketplace_id: "ATVPDKIKX0DER" }],
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
  assert.deepEqual(p.aspects, { Flavor: "Berry Blast", "Item Form": "Gummy", "Product Benefit": "Gut Health" });
  assert.match(formatAspectsLine(p.aspects), /Flavor: Berry Blast/);
  assert.deepEqual(p.package, { length_in: 10, width_in: 5, height_in: 2, weight_lb: 1.5 });
  assert.deepEqual(p.images, ["big.jpg", "pt.jpg"]);
  assert.equal(p.product_type, "CONSUMER_ELECTRONICS");
  assert.deepEqual(pickLargestImages([]), []);
});

test("extractCatalogAspects ignores empty / unknown attributes", () => {
  assert.deepEqual(extractCatalogAspects({}), {});
  assert.deepEqual(extractCatalogAspects({ color: [{ value: "  Red  ", marketplace_id: "ATVPDKIKX0DER" }] }), { Color: "Red" });
  assert.equal(formatAspectsLine({}), "");
});

test("item specifics rejects numeric retailer codes; prefers pack phrase from title", () => {
  assert.equal(usableModelNumber("4610583"), null);
  assert.equal(usableModelNumber("WP-100"), "WP-100");
  assert.match(
    variantFromTitle("Oral-B Replacement Brush Heads, 10 Count Soft", "Oral-B"),
    /brush heads.*10 count/i,
  );
  const oralB = itemSpecificsFromLookup({
    model: "4610583",
    title: "Oral-B Replacement Brush Heads 10 Pack",
    brand: "Oral-B",
  });
  assert.match(oralB, /brush heads/i);
  assert.match(oralB, /10 pack/i);
  assert.doesNotMatch(oralB, /^4610583$/);
  assert.equal(
    itemSpecificsFromLookup({ model: "EB-20", title: "Oral-B Something", brand: "Oral-B" }),
    "Something",
  );
});

test("mergeLookup drops digit retailer model codes from upcitemdb", () => {
  const { merged, fieldCoverage } = mergeLookup(
    { found: true, title: "Oral-B Replacement Brush Heads 10 Pack", brand: "Oral-B", model: "4610583", aspects: {}, package: {}, images: [] },
    { found: true, title: "Oral-B Heads", brand: "Oral-B", model: "4610583", package: {}, images: [] },
  );
  assert.equal(merged.model, null);
  assert.equal(fieldCoverage.model, null);
});

test("merge marks not_found when both sources miss", () => {
  const { merged } = mergeLookup({ found: false }, { found: false });
  assert.equal(merged.not_found, true);
  assert.equal(merged.title, null);
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
  const empty = {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: null, error: null }),
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
    upsert: async () => ({ data: null, error: null }),
    insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: "miss-1" }, error: null }) }) }),
    update: () => ({ eq: async () => ({ error: null }) }),
  };
  return {
    store,
    from(table) {
      if (table === "floor_products" || table === "upc_lookup_misses") return empty;
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

test("clean UPC misses are retried instead of becoming permanent cache hits", async () => {
  const sb = fakeSb();
  let calls = 0;
  const deps = {
    sb,
    catalogByIdentifier: async () => { calls++; return { found: false, alternatives: [] }; },
    priceByAsin: async () => ({}),
    upcitemdb: async () => ({ found: false, tier: 'trial' }),
    ebayComps: async () => null,
  };
  await lookupUpc('s', '012345678905', { deps });
  await lookupUpc('s', '012345678905', { deps });
  assert.equal(calls, 6); // UPC, EAN, GTIN on each scan
  assert.equal(sb.store.size, 0);
});

test('retailer store-label UPC bypasses public product lookups until Floor has a confirmed match', async () => {
  let amazonCalls = 0;
  let upcCalls = 0;
  const result = await lookupUpc('store', '490680352443', { deps: {
    sb: fakeSb(),
    catalogByIdentifier: async () => { amazonCalls++; return { found: true, item: parseCatalogItem(catalogItem) }; },
    priceByAsin: async () => ({}),
    upcitemdb: async () => { upcCalls++; return { found: true, title: 'wrong product' }; },
    ebayComps: async () => null,
  } });
  assert.equal(result.store_label, true);
  assert.match(result.warning, /store sticker/i);
  assert.equal(result.merged.not_found, true);
  assert.equal(amazonCalls, 0);
  assert.equal(upcCalls, 0);
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

test("a catalog hit must list the scanned barcode", () => {
  const topper = [{ type: "EAN", value: "0617014003691" }];
  const tee = [{ type: "UPC", value: "195949111111" }];
  assert.equal(catalogIdentifierMatches(topper, "617014003691"), true);
  assert.equal(catalogIdentifierMatches(topper, "00617014003691"), true);
  assert.equal(catalogIdentifierMatches(tee, "617014003691"), false);
});

test("unrelated amazon product does not replace the UPC item", () => {
  const amazon = {
    found: true,
    identifier_match: true,
    asin: "B09GZVNLN2",
    title: "#istandwithniki, Niki, Niki M Raglan Baseball Tee",
    brand: "Niki",
    category: "Women",
    package: {},
    images: ["tee.jpg"],
  };
  const upc = {
    found: true,
    title: 'Twin 2" Cool Touch Memory Foam Mattress Topper - Threshold',
    brand: "Threshold",
    package: {},
    images: ["topper.jpg"],
  };
  const { merged, amazonAccepted, fieldCoverage } = mergeLookup(amazon, upc);
  assert.equal(amazonAccepted, false);
  assert.equal(merged.brand, "Threshold");
  assert.match(merged.title, /Mattress Topper/);
  assert.equal(merged.images[0], "topper.jpg");
  assert.equal(fieldCoverage.title, "upcitemdb");
  assert.equal(fieldCoverage.brand, "upcitemdb");
});

test("exact identifier match still wins when the other source describes the same product", () => {
  const { merged, amazonAccepted } = mergeLookup(
    { found: true, identifier_match: true, title: "Threshold Farrah Curtain Panel", brand: "Threshold", package: {}, images: [] },
    { found: true, title: "Farrah Window Curtain Panel White - Threshold", brand: "Threshold", package: {}, images: [] },
  );
  assert.equal(amazonAccepted, true);
  assert.equal(merged.title, "Threshold Farrah Curtain Panel");
});

test("lookup keeps the UPC product when Amazon returns a different brand and title", async () => {
  const sb = fakeSb();
  const deps = {
    sb,
    catalogByIdentifier: async () => ({
      found: true,
      identifier_match: true,
      item: {
        asin: "B09GZVNLN2",
        title: "#istandwithniki, Niki, Niki M Raglan Baseball Tee",
        brand: "Niki",
        model: null,
        category: "Women",
        description: null,
        features: [],
        aspects: {},
        package: {},
        images: [],
      },
    }),
    priceByAsin: async () => ({ price_cents: 1999, source: "buybox", as_of: "2026-10-30T00:00:00.000Z" }),
    upcitemdb: async () => ({
      found: true,
      title: 'Twin 2" Cool Touch Memory Foam Mattress Topper - Threshold',
      brand: "Threshold",
      description: "Cool touch memory foam",
      package: {},
      images: [],
    }),
    ebayComps: async () => null,
  };
  const result = await lookupUpc("s", "617014003691", { deps, compareUpcitemdb: true, skipEbay: true });
  assert.equal(result.amazon.found, false);
  assert.equal(result.amazon.skipped, "unrelated_product");
  assert.equal(result.merged.brand, "Threshold");
  assert.match(result.merged.title, /Mattress Topper/);
  assert.equal(result.merged.retail_cents, null);
  assert.equal(result.merged.never_list_reason, undefined);
});

test("a saved contradicted catalog row is not shown and is not rewritten", async () => {
  let writes = 0;
  const owned = {
    gtin14: "00617014003691",
    brand: "Niki",
    title: "Niki #istandwithniki, Niki, Niki M Raglan Baseball Tee",
    model: "Classic",
    category: "Women",
    updated_at: "2026-10-30T21:41:38.389Z",
  };
  const payload = {
    amazon: { found: true, brand: "Niki", title: "#istandwithniki, Niki, Niki M Raglan Baseball Tee" },
    upcitemdb: { found: true, brand: "Threshold", title: 'Twin 2" Cool Touch Memory Foam Mattress Topper - Threshold' },
    merged: { title: owned.title, brand: "Niki" },
  };
  const sb = {
    from(table) {
      const row = table === "floor_products" ? owned : table === "upc_lookup_cache" ? { payload, looked_up_at: owned.updated_at } : null;
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        upsert() { writes += 1; return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }; },
        insert: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      };
    },
  };
  const result = await lookupUpc("s", "617014003691", {
    deps: {
      sb,
      catalogByIdentifier: async () => ({
        found: true,
        identifier_match: true,
        item: { asin: "B09GZVNLN2", title: payload.amazon.title, brand: "Niki", category: "Women", features: [], aspects: {}, package: {}, images: [] },
      }),
      priceByAsin: async () => ({ price_cents: null, source: null, as_of: "2026-10-30T00:00:00.000Z" }),
      upcitemdb: async () => ({ found: true, title: payload.upcitemdb.title, brand: "Threshold", package: {}, images: [] }),
      ebayComps: async () => null,
    },
    compareUpcitemdb: true,
    skipEbay: true,
  });
  assert.equal(writes, 0);
  assert.equal(result.floor_product, undefined);
  assert.equal(result.merged.brand, "Threshold");
  assert.match(result.merged.title, /Mattress Topper/);
});

const STORE_CATEGORIES = ["Uncategorized", "Mattresses", "Mattress Pads & Toppers", "Bedding", "Apparel", "Refrigerator"];
const LIVE_STORE_CATEGORIES = ["Uncategorized", "Mattresses", "Apparel", "Refrigerator"];

test("mattress pads, toppers, and protectors do not map to Mattresses or get never-listed for that reason", () => {
  const accessories = [
    { title: "Threshold Memory Foam Mattress Topper, Twin" },
    { title: "Waterproof Mattress Pad, Queen" },
    { title: "Quiet Night Mattress Protector, King" },
  ];
  for (const item of accessories) {
    assert.equal(matchReceiveCategory(STORE_CATEGORIES, item), "Mattress Pads & Toppers");
    assert.equal(matchReceiveCategory(LIVE_STORE_CATEGORIES, item), "");
    assert.equal(amazonNeverListReason({ ...item, category: "Mattresses" }), null);
    assert.equal(amazonNeverListReason({ ...item, category: "Mattress Pads & Toppers" }), null);
  }
  assert.equal(matchReceiveCategory(["Uncategorized", "Mattresses", "Bedding"], {
    title: "Cool Touch Mattress Topper",
  }), "Bedding");
  assert.equal(matchReceiveCategory(STORE_CATEGORIES, {
    title: "Threshold Queen Memory Foam Mattress",
  }), "Mattresses");
  assert.equal(amazonNeverListReason({
    title: "Threshold Queen Memory Foam Mattress",
    category: "Mattresses",
  }), "Appliance/mattress — never list online");
  assert.equal(matchReceiveCategory(STORE_CATEGORIES, { category: "Refrigerator", title: "LG top freezer" }), "Refrigerator");
  assert.equal(matchReceiveCategory(STORE_CATEGORIES, {
    category: "Women",
    title: "Niki Raglan Baseball Tee",
    brand: "Niki",
  }), "");
  assert.deepEqual(filterCategoryOptions(STORE_CATEGORIES, "matt"), ["Mattresses", "Mattress Pads & Toppers"]);
  assert.deepEqual(filterCategoryOptions(STORE_CATEGORIES, ""), STORE_CATEGORIES);
  assert.deepEqual(filterCategoryOptions(STORE_CATEGORIES, "Mattresses"), STORE_CATEGORIES);
  assert.deepEqual(filterCategoryOptions(STORE_CATEGORIES, "zzz"), []);
});
