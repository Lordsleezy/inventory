import test from "node:test";
import assert from "node:assert/strict";
import { autofillUnitSpecifics, fillMissing, missingRequired, aspectFieldsFromTaxonomy } from "./ebay-specifics.mjs";

const FIELDS = [
  { name: "Brand", required: true, allowed: [], selection_only: false },
  { name: "Type", required: true, allowed: ["Garment Steamer", "Handheld Steamer"], selection_only: true },
  { name: "Color", required: false, recommended: true, allowed: [], selection_only: false },
];

function fakeDeps({ unit, row = null, product = null, catalogHit = null }) {
  const calls = { catalog: 0, saved: [], remembered: [] };
  const products = new Map(product ? [[product.gtin14, product]] : []);
  const rows = new Map(row ? [[unit.sku, row]] : []);
  const units = new Map([[unit.sku, unit]]);
  const deps = {
    loadUnit: async (_s, sku) => units.get(sku) || null,
    loadEbayRow: async (_s, sku) => rows.get(sku) || null,
    loadProduct: async (gtin14) => products.get(gtin14) || null,
    catalog: async () => { calls.catalog++; return catalogHit; },
    aspectFields: async () => FIELDS,
    saveEbayRow: async (_s, sku, patch) => {
      calls.saved.push({ sku, ...patch });
      rows.set(sku, { ...(rows.get(sku) || { enabled: true }), ...patch });
    },
    remember: async (gtin14, { categoryId, attributes }) => {
      calls.remembered.push(gtin14);
      products.set(gtin14, { ...(products.get(gtin14) || { gtin14 }), ebay_category_id: categoryId, ebay_aspects: attributes });
    },
  };
  return { deps, calls, units, rows };
}

test("fillMissing never overwrites a set value and only accepts allowed values for selection-only aspects", () => {
  const { attributes, filled } = fillMissing({ Brand: "Conair" },
    { Brand: "Other", Type: "handheld steamer", Color: ["White"] }, FIELDS);
  assert.deepEqual(attributes, { Brand: "Conair", Type: "Handheld Steamer", Color: "White" });
  assert.deepEqual(filled, ["Type", "Color"]);
  assert.deepEqual(fillMissing({}, { Type: "Iron" }, FIELDS).attributes, {});
  assert.deepEqual(missingRequired(FIELDS, { Brand: "X" }), ["Type"]);
  assert.deepEqual(missingRequired(FIELDS, { Brand: "X", Type: "Iron" }), ["Type"]);
});

test("Catalog API results fill aspects without overwriting existing values", async () => {
  const unit = { sku: "11548", upc: "074108412348" };
  const { deps, calls } = fakeDeps({ unit, row: { category_id: "20614", enabled: true, attributes: { Brand: "Conair Pro" } },
    catalogHit: { categoryId: "99999", aspects: { Brand: ["Conair"], Type: ["Garment Steamer"], Color: ["Black"] } } });
  const r = await autofillUnitSpecifics(deps, "store", "11548");
  assert.equal(calls.catalog, 1);
  assert.equal(r.categoryId, "20614", "existing category is never replaced");
  assert.equal(r.categorySource, null);
  assert.deepEqual(calls.saved[0].attributes, { Brand: "Conair Pro", Type: "Garment Steamer", Color: "Black" });
  assert.equal(calls.saved[0].category_id, undefined);
  assert.equal(r.complete, true);
});

test("Catalog fills a missing category; no UPC means nothing is guessed", async () => {
  const { deps } = fakeDeps({ unit: { sku: "1", upc: "074108412348" },
    catalogHit: { categoryId: "20614", aspects: { Brand: "Conair", Type: "Garment Steamer" } } });
  const r = await autofillUnitSpecifics(deps, "store", "1");
  assert.equal(r.categoryId, "20614");
  assert.equal(r.categorySource, "ebay_catalog");
  const none = fakeDeps({ unit: { sku: "2", upc: "" } });
  const r2 = await autofillUnitSpecifics(none.deps, "store", "2");
  assert.equal(r2.reason, "no_category");
  assert.equal(none.calls.catalog, 0);
});

test("UPC memory: second unit with the same UPC fills instantly with no Catalog lookup", async () => {
  const first = { sku: "A1", upc: "074108412348" };
  const env = fakeDeps({ unit: first, catalogHit: { categoryId: "20614", aspects: { Brand: "Conair", Type: "Garment Steamer" } } });
  const r1 = await autofillUnitSpecifics(env.deps, "store", "A1");
  assert.equal(r1.complete, true);
  assert.deepEqual(env.calls.remembered, ["00074108412348"]);
  env.units.set("A2", { sku: "A2", upc: "074108412348" });
  env.deps.catalog = async () => { throw new Error("catalog must not be called"); };
  const r2 = await autofillUnitSpecifics(env.deps, "store", "A2");
  assert.equal(r2.categoryId, "20614");
  assert.equal(r2.categorySource, "floor_upc_memory");
  assert.equal(r2.usedCatalog, false);
  assert.equal(r2.complete, true);
  assert.deepEqual(env.rows.get("A2").attributes, { Brand: "Conair", Type: "Garment Steamer" });
});

test("incomplete items are not remembered; eBay-disabled units are skipped", async () => {
  const env = fakeDeps({ unit: { sku: "B", upc: "074108412348" }, catalogHit: { categoryId: "20614", aspects: { Brand: "Conair" } } });
  const r = await autofillUnitSpecifics(env.deps, "store", "B");
  assert.deepEqual(r.missing, ["Type"]);
  assert.equal(env.calls.remembered.length, 0);
  const off = fakeDeps({ unit: { sku: "C", upc: "074108412348" }, row: { enabled: false, category_id: null } });
  assert.equal((await autofillUnitSpecifics(off.deps, "store", "C")).skipped, "ebay_disabled");
});

test("aspect fields list required first, then recommended", () => {
  const out = aspectFieldsFromTaxonomy([
    { name: "Color", recommended: true, allowed: [], sortIndex: 0 },
    { name: "Type", required: true, allowed: ["A"], selectionOnly: true, sortIndex: 1 },
    { name: "Notes", allowed: [], sortIndex: 2 },
  ]);
  assert.deepEqual(out.map((f) => f.name), ["Type", "Color", "Notes"]);
  assert.equal(out[0].selection_only, true);
});

test("autofill pulls live eBay specifics, unit fields and same-UPC specifics, and never overwrites a value", async () => {
  const FIELDS2 = [
    { name: "Brand", required: true, allowed: [] }, { name: "Type", required: true, allowed: [] },
    { name: "Color", required: true, allowed: [] }, { name: "Material", required: true, allowed: [] },
    { name: "UPC", required: false, allowed: [] },
  ];
  const unit = { sku: "99844", upc: "012345678905", brand: "Acme", model: "M1", title: "t" };
  const rows = new Map([["99844", { category_id: "111", enabled: true, attributes: { Color: "Blue" } }]]);
  const saved = [];
  const deps = {
    loadUnit: async () => unit, loadEbayRow: async (_s, sku) => rows.get(sku) || null, loadProduct: async () => null,
    catalog: async () => { throw new Error("403"); },
    aspectFields: async () => FIELDS2,
    loadLive: async () => ({ categoryId: "111", aspects: { Type: ["Steamer"], Color: ["Red"], Brand: ["Other"] } }),
    loadSiblings: async () => [{ Material: "Plastic", Type: "Iron" }],
    saveEbayRow: async (_s, sku, patch) => { saved.push(patch); },
    remember: async () => {},
  };
  const r = await autofillUnitSpecifics(deps, "s", "99844");
  assert.deepEqual(saved[0].attributes, { Color: "Blue", Type: "Steamer", Brand: "Other", Material: "Plastic", UPC: "012345678905" },
    "Color was already set; live listing beats the unit field for Brand; sibling only fills what is still blank");
  assert.equal(r.complete, true);
  assert.equal(r.usedCatalog, false, "a 403 from the Catalog API never blocks anything");
});

test("a category taken from the live listing is saved as live_listing", async () => {
  const saved = [];
  const deps = {
    loadUnit: async () => ({ sku: "1", upc: null, brand: "Acme", model: "", title: "t" }), loadEbayRow: async () => null, loadProduct: async () => null,
    catalog: async () => null, aspectFields: async () => FIELDS,
    loadLive: async () => ({ categoryId: "222", aspects: { Type: ["Handheld Steamer"] } }),
    saveEbayRow: async (_s, _sku, patch) => { saved.push(patch); }, remember: async () => {},
  };
  const r = await autofillUnitSpecifics(deps, "s", "1");
  assert.equal(r.categorySource, "live_listing");
  assert.equal(saved[0].source, "live_listing");
  assert.equal(saved[0].attributes.Type, "Handheld Steamer");
});
