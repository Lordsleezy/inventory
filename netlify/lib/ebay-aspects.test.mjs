import assert from "node:assert/strict";
import test from "node:test";
import { matchAllowedValue, pickAspectValue, aspectsFromTaxonomy } from "./ebay-aspects.mjs";

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
