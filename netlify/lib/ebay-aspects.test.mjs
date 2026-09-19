import assert from "node:assert/strict";
import test from "node:test";
import { matchAllowedValue, matchMeasureBucket, pickAspectValue, pickTypeValue, aspectsFromTaxonomy, fillAspects } from "./ebay-aspects.mjs";

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

test("maps quoted spec inches and mixed-case / cm width buckets", () => {
  const widthBuckets = ["54 cm", "More Than 40 in", "More than 55 in", "More than 25 in"];
  assert.equal(matchMeasureBucket(widthBuckets, '32"'), "More than 25 in");
  assert.equal(matchMeasureBucket(widthBuckets, "35.75"), "More than 25 in");
  assert.equal(matchMeasureBucket(["54 cm", "32 in", "36 in"], 32), "32 in");
  const { aspects, missing } = aspectsFromTaxonomy(
    [
      {
        localizedAspectName: "Item Width",
        aspectConstraint: { aspectRequired: true },
        aspectValues: widthBuckets.map((value) => ({ localizedValue: value })),
      },
    ],
    { brand: "LG", model: "LTCS20020V", category: "Refrigerator" },
    { width_in: '32"' },
  );
  assert.equal(aspects["Item Width"][0], "More than 25 in");
  assert.equal(missing.length, 0);
  const fromJob = aspectsFromTaxonomy(
    [
      {
        localizedAspectName: "Item Width",
        aspectConstraint: { aspectRequired: true },
        aspectValues: widthBuckets.map((value) => ({ localizedValue: value })),
      },
    ],
    { brand: "LG", model: "LTCS20020V", category: "Refrigerator" },
    { listing_body: '35.75" W × 69.88" H × 32.38" D' },
  );
  assert.equal(fromJob.aspects["Item Width"][0], "More than 25 in");
  assert.equal(fromJob.missing.length, 0);
});

test("writes exact inches when eBay width buckets skip the 30-inch range", () => {
  const fridgeWidth = ["Less Than 10 in", "Less Than 25 in", "More Than 40 in", "More than 55 in", "54 cm"];
  const { aspects, missing } = aspectsFromTaxonomy(
    [
      {
        localizedAspectName: "Item Width",
        aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" },
        aspectValues: fridgeWidth.map((value) => ({ localizedValue: value })),
      },
      {
        localizedAspectName: "Item Height",
        aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" },
        aspectValues: ["Less Than 50 in", "More Than 50 in", "More than 65 in"].map((value) => ({
          localizedValue: value,
        })),
      },
    ],
    { brand: "Midea", model: "MRT21D3BST", category: "Refrigerator" },
    { width_in: '29.7"', height_in: '66.6"', weight_lb: 158.7 },
  );
  assert.equal(aspects["Item Width"][0], "29.7 in");
  assert.equal(aspects["Item Height"][0], "More than 65 in");
  assert.equal(missing.length, 0);
});

test("PrintProof stainless maps to Silver because eBay Color has no Stainless Steel", () => {
  const aspect = {
    localizedAspectName: "Color",
    aspectConstraint: { aspectRequired: true },
    aspectValues: ["Black", "Silver", "White"].map((value) => ({ localizedValue: value })),
  };
  assert.equal(pickAspectValue(aspect, ["Silver", "PrintProof stainless, pocket handles"]), "Silver");
  const filled = aspectsFromTaxonomy(
    [
      {
        localizedAspectName: "Color",
        aspectConstraint: { aspectRequired: true },
        aspectValues: ["Black", "Silver", "White"].map((value) => ({ localizedValue: value })),
      },
    ],
    { brand: "LG", model: "LRYXC2606S", category: "Refrigerator" },
    { finish: "PrintProof stainless, pocket handles" },
  );
  assert.equal(filled.aspects.Color[0], "Silver");
});

test("does not stuff Freestanding or cabinet width into EU / unrelated aspects", () => {
  const { aspects } = fillAspects(
    [
      { name: "Installation", required: true, allowed: ["Built-In", "Freestanding"] },
      { name: "EPREL Registration Number", recommended: true, allowed: [] },
      { name: "California Prop 65 Warning", recommended: true, allowed: [] },
      { name: "Unit Quantity", recommended: true, allowed: [] },
      { name: "Open Door Width", recommended: true, allowed: ["35.1-40 in", "More Than 40 in"] },
      { name: "Bottle Capacity", recommended: true, allowed: [] },
      { name: "Energy Star", recommended: true, allowed: ["1 Star", "2 Stars", "A+++", "A++"] },
      { name: "Item Width", required: true, allowed: ["Less Than 25 in", "More Than 40 in"], selectionOnly: false },
    ],
    { brand: "LG", model: "LRYXC2606S", category: "Refrigerator" },
    { width_in: "35.75", installation: "Freestanding", capacity_cu_ft: "25.5" },
    { categoryDefaults: { Installation: "Freestanding" }, standalone: true },
  );
  assert.equal(aspects.Installation[0], "Freestanding");
  assert.equal(aspects["Item Width"][0], "35.75 in");
  assert.equal(aspects["EPREL Registration Number"], undefined);
  assert.equal(aspects["California Prop 65 Warning"], undefined);
  assert.equal(aspects["Unit Quantity"], undefined);
  assert.equal(aspects["Open Door Width"], undefined);
  assert.equal(aspects["Bottle Capacity"], undefined);
  assert.equal(aspects["Energy Star"], undefined);
});

const FRIDGE_TYPES = [
  "Bottom Freezer",
  "Built-in Bottom Freezer Refrigerator",
  "Built-in Top Freezer Refrigerator",
  "European Side-by-Side Refrigerator",
  "Freestanding Refrigerator",
  "French Door Refrigerator",
  "Side-by-Side Refrigerator",
];

test("freestanding top-freezer Type is not the built-in variant", () => {
  assert.equal(
    pickTypeValue(FRIDGE_TYPES, { category: "Refrigerator" }, { configuration: "Top Freezer", installation: "Freestanding" }, {
      standalone: true,
      categoryDefaults: { Installation: "Freestanding" },
    }),
    "Freestanding Refrigerator",
  );
  const { aspects } = fillAspects(
    [
      { name: "Type", required: true, allowed: FRIDGE_TYPES },
      { name: "Installation", required: true, allowed: ["Built-In", "Freestanding"] },
    ],
    { brand: "LG", model: "LTCS20020V", category: "Refrigerator" },
    { configuration: "Top Freezer", installation: "Freestanding" },
    { categoryDefaults: { Installation: "Freestanding" }, standalone: true },
  );
  assert.equal(aspects.Type[0], "Freestanding Refrigerator");
  assert.equal(aspects.Installation[0], "Freestanding");
});

test("built-in install can still pick a built-in Type", () => {
  assert.equal(
    pickTypeValue(FRIDGE_TYPES, { category: "Refrigerator" }, { configuration: "Top Freezer", installation: "Built-In" }, {
      standalone: true,
    }),
    "Built-in Top Freezer Refrigerator",
  );
});

test("French door stays French door, not a built-in type", () => {
  assert.equal(
    pickTypeValue(FRIDGE_TYPES, { category: "Refrigerator" }, { configuration: "French door", installation: "Freestanding" }, {
      standalone: true,
    }),
    "French Door Refrigerator",
  );
});

test("remembered built-in Type is ignored on a freestanding unit", () => {
  const { aspects } = fillAspects(
    [{ name: "Type", required: true, allowed: FRIDGE_TYPES }],
    { category: "Refrigerator" },
    { configuration: "Top Freezer", installation: "Freestanding" },
    {
      remembered: { Type: "Built-in Top Freezer Refrigerator" },
      categoryDefaults: { Installation: "Freestanding" },
      standalone: true,
    },
  );
  assert.equal(aspects.Type[0], "Freestanding Refrigerator");
});

