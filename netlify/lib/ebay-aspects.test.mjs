import assert from "node:assert/strict";
import test from "node:test";
import { matchAllowedValue, matchMeasureBucket, pickAspectValue, aspectsFromTaxonomy } from "./ebay-aspects.mjs";

test("Type maps refrigerator to an allowed appliance type, not Air Filter", () => {
  const allowed = ["Air Filter", "Compact Refrigerator", "Refrigerator", "Wine Fridge"];
  assert.equal(matchAllowedValue(allowed, ["Refrigerator", "Air Filter"]), "Refrigerator");
  const aspect = {
    localizedAspectName: "Type",
    aspectConstraint: { aspectRequired: true },
    aspectValues: allowed.map((value) => ({ localizedValue: value })),
  };
  assert.equal(pickAspectValue(aspect, ["Refrigerator", "French door"]), "Refrigerator");
  assert.notEqual(pickAspectValue(aspect, ["does-not-exist"]), "Air Filter");
});

test("Color maps finish text to an allowed color instead of stuffing the whole blob", () => {
  const aspect = {
    localizedAspectName: "Color",
    aspectConstraint: { aspectRequired: true },
    aspectValues: ["Black", "Stainless Steel", "White"].map((value) => ({ localizedValue: value })),
  };
  assert.equal(pickAspectValue(aspect, ["smooth white, pocket handles"]), "White");
  assert.equal(pickAspectValue(aspect, ["fingerprint-resistant stainless steel"]), "Stainless Steel");
});

test("required aspects with no allowed match are reported, not guessed", () => {
  const { aspects, missing } = aspectsFromTaxonomy(
    [
      {
        localizedAspectName: "Type",
        aspectConstraint: { aspectRequired: true },
        aspectValues: [{ localizedValue: "Air Filter" }, { localizedValue: "Refrigerator" }],
      },
      {
        localizedAspectName: "Color",
        aspectConstraint: { aspectRequired: true },
        aspectValues: [{ localizedValue: "White" }, { localizedValue: "Black" }],
      },
    ],
    { brand: "LG", model: "LTCS20020V", category: "Refrigerator" },
    { finish: "unknown iridescent foil", configuration: "Air Filter" },
  );
  assert.equal(aspects.Type[0], "Refrigerator");
  assert.ok(missing.some((row) => /Color/i.test(row)));
  assert.ok(!missing.some((row) => /Type/i.test(row)));
});

test("maps real inches onto eBay height/width buckets", () => {
  const buckets = ["Less Than 20 in", "More Than 25 in", "More Than 50 in", "20-25 in"];
  assert.equal(matchMeasureBucket(buckets, 70), "More Than 50 in");
  assert.equal(matchMeasureBucket(buckets, 32), "More Than 25 in");
  assert.equal(matchMeasureBucket(buckets, 22), "20-25 in");
  const { aspects, missing } = aspectsFromTaxonomy(
    [
      {
        localizedAspectName: "Item Height",
        aspectConstraint: { aspectRequired: true },
        aspectValues: buckets.map((value) => ({ localizedValue: value })),
      },
      {
        localizedAspectName: "Item Width",
        aspectConstraint: { aspectRequired: true },
        aspectValues: buckets.map((value) => ({ localizedValue: value })),
      },
      {
        localizedAspectName: "Model",
        aspectConstraint: { aspectRequired: true },
        aspectValues: ["KG36EALCA", "KGN39VLEA", "KGE49PICA"].map((value) => ({ localizedValue: value })),
      },
      {
        localizedAspectName: "Installation",
        aspectConstraint: { aspectRequired: true },
        aspectValues: ["Built-In", "Freestanding", "Undercounter"].map((value) => ({ localizedValue: value })),
      },
    ],
    { brand: "LG", model: "LTCS20020V", category: "Refrigerator" },
    { width_in: "32", height_in: "70", depth_in: "33" },
  );
  assert.equal(aspects["Item Height"][0], "More Than 50 in");
  assert.equal(aspects["Item Width"][0], "More Than 25 in");
  assert.equal(aspects.Model[0], "LTCS20020V");
  assert.equal(aspects.Installation[0], "Freestanding");
  assert.equal(missing.length, 0);
});
