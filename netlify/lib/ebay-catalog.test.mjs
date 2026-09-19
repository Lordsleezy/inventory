import assert from "node:assert/strict";
import test from "node:test";
import { aspectsNeedRefresh, fillAspects } from "./ebay-aspects.mjs";
import { resolveFloorCategory } from "./ebay-catalog.mjs";

test("maps store category labels onto Floor eBay categories", () => {
  assert.equal(resolveFloorCategory("Refrigerator")?.ebayCategoryId, "20713");
  assert.equal(resolveFloorCategory("chest freezer")?.slug, "freezers");
  assert.equal(resolveFloorCategory("washing machines")?.slug, "washers");
  assert.equal(resolveFloorCategory("TVs")?.ebayCategoryId, "11071");
  assert.equal(resolveFloorCategory("Furniture"), null);
});

test("fills required aspects from unit specs, defaults, and remembered choices", () => {
  const defs = [
    { name: "Brand", required: true, allowed: [] },
    { name: "Model", required: true, allowed: [] },
    { name: "Item Width", required: true, allowed: ["54 cm", "More Than 40 in", "More than 25 in"] },
    { name: "Installation", required: true, allowed: ["Built-In", "Freestanding"] },
    { name: "Color", required: true, allowed: ["Black", "Stainless Steel", "White"] },
    { name: "Type", recommended: true, allowed: ["Refrigerator", "Wine Fridge"] },
  ];
  const { aspects, missing, filled } = fillAspects(
    defs,
    { brand: "LG", model: "LTCS20020V", category: "Refrigerator" },
    { width_in: '32"', finish: "stainless steel" },
    { categoryDefaults: { Installation: "Freestanding" }, standalone: true },
  );
  assert.equal(aspects.Brand[0], "LG");
  assert.equal(aspects.Model[0], "LTCS20020V");
  assert.equal(aspects["Item Width"][0], "More than 25 in");
  assert.equal(aspects.Installation[0], "Freestanding");
  assert.equal(aspects.Color[0], "Stainless Steel");
  assert.equal(aspects.Type[0], "Refrigerator");
  assert.equal(missing.length, 0);
  assert.equal(filled.find((row) => row.name === "Color").source, "unit");
});

test("reports every required gap at once and prefers a stored override", () => {
  const defs = [
    { name: "Item Width", required: true, allowed: ["More than 25 in"] },
    { name: "Color", required: true, allowed: ["White", "Black"] },
    { name: "Energy Star", required: true, allowed: ["Yes", "No"] },
  ];
  const { missing, aspects } = fillAspects(
    defs,
    { brand: "LG", model: "X", category: "Refrigerator" },
    { ebay_aspects: { Color: "White" } },
    {},
  );
  assert.equal(aspects.Color[0], "White");
  assert.deepEqual(missing.map((row) => row.replace(/ \(.*\)$/, "")).sort(), ["Energy Star", "Item Width"]);
});

test("detects a new or renamed required aspect without a code change", () => {
  const stored = [{ name: "Item Width", required: true, allowed: ["More than 25 in"] }];
  const live = [
    { name: "Item Width", required: true, allowed: ["More than 25 in"] },
    { name: "Door Style", required: true, allowed: ["French Door", "Top Freezer"] },
  ];
  assert.equal(aspectsNeedRefresh(stored, live), true);
  assert.equal(aspectsNeedRefresh(live, live), false);
});
