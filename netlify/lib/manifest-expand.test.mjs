import test from "node:test";
import assert from "node:assert/strict";
import { acceptedExpansion, categoryFits, manufacturerUpc } from "./manifest-expand.mjs";
import { identityCanPick } from "./manifest-pick.mjs";

test("a longer name that shares the manifest words is kept, and a distributor is not a brand", () => {
  const kept = acceptedExpansion({
    description: "SI ROLLING MASSAGER",
    brand: "",
    vendor: "MERCHSOURCE LLC",
    title: "Sharper Image Rolling Massager",
    expandedBrand: "Sharper Image",
    model: "SI-500",
    manufacturerUpc: "012345678905",
  });
  assert.equal(kept.expanded_title, "Sharper Image Rolling Massager");
  assert.equal(kept.expanded_brand, "Sharper Image");
  assert.equal(kept.manufacturer_upc, "012345678905");
});

test("a guessed name that shares no words is dropped", () => {
  const kept = acceptedExpansion({
    description: "KODA 5000L SECURITY LIGHT",
    brand: "Koda",
    vendor: "SOME COMPANY",
    title: "Completely Unrelated Blender",
    expandedBrand: "Other",
    model: "",
    manufacturerUpc: "123",
  });
  assert.equal(kept.expanded_title, "");
  assert.equal(kept.expanded_brand, "Koda");
  assert.equal(kept.manufacturer_upc, "");
  assert.equal(manufacturerUpc("499912345678"), "");
});

test("an unidentified photo does not pick a manifest line", () => {
  assert.equal(identityCanPick({ brand: "", title: "" }), false);
  assert.equal(identityCanPick({ brand: "Degree", title: "Degree Max Protection" }), true);
});

test("a category is kept only when its name fits the product", () => {
  assert.equal(categoryFits("Philips Sonicare Advanced Clean Electric Toothbrush", "Electric Toothbrushes"), true);
  assert.equal(categoryFits("Nikko RC 1:14 Elite Red Bull Race Car", "Posters & Prints"), false);
});
