import test from "node:test";
import assert from "node:assert/strict";
import { listingTitle, productToMerged } from "./floor-products.mjs";
import { itemSpecificsFromLookup } from "./amazon.mjs";

test("listingTitle is brand + model", () => {
  assert.equal(listingTitle("Oral-B", "Replacement Brush Heads 10 Pack"), "Oral-B Replacement Brush Heads 10 Pack");
  assert.equal(listingTitle("", "Widget"), "Widget");
  assert.equal(listingTitle("Acme", "", true), "Unbranded");
});

test("productToMerged drops digit model codes", () => {
  const m = productToMerged({
    brand: "Oral-B",
    model: "4610583",
    title: "Oral-B Replacement Brush Heads 10 Pack",
    aspects: {},
    features: [],
    images: [],
    package_length_in: 2,
    package_width_in: 3,
    package_height_in: 4,
    package_weight_lb: 0.5,
  });
  assert.match(m.model, /brush heads|10 pack/i);
  assert.doesNotMatch(m.model, /^4610583$/);
  assert.equal(m.package.weight_lb, 0.5);
});

test('saved estimates never prefill a new receive while real lookups are pending', () => {
  const result=productToMerged({brand:'Acme',title:'Acme household item',package_weight_lb:2,package_length_in:8,
    aspects:{product_weight_lb:1,Color:'Blue'},dim_sources:{weight_lb:'estimated',product_weight_lb:'AI estimate',length_in:'staff'}});
  assert.equal(result.package.weight_lb,null);
  assert.equal(result.package.length_in,8);
  assert.equal(result.aspects.product_weight_lb,undefined);
  assert.equal(result.aspects.Color,'Blue');
});

test("item specifics from Oral-B style title", () => {
  const s = itemSpecificsFromLookup({
    model: "4610583",
    title: "Oral-B Replacement Brush Heads 10 Pack",
    brand: "Oral-B",
  });
  assert.match(s, /brush heads/i);
  assert.match(s, /10 pack/i);
});
