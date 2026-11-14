import test from "node:test";
import assert from "node:assert/strict";
import { acceptedExpansion, categoryFits, chooseStockPhoto, manufacturerUpc } from "./manifest-expand.mjs";
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

test("a stock photo must match the manifest line", () => {
  const line = "DISNEY HALLOWEEN VILLAGE";
  assert.equal(chooseStockPhoto(line, [
    { url: "https://m.media-amazon.com/images/I/wrong.jpg", title: "Moments in Time" },
    { url: "https://i.ebayimg.com/images/g/village.jpg", title: "Disney Halloween Village" },
  ]), "https://i.ebayimg.com/images/g/village.jpg");
  assert.equal(chooseStockPhoto(line, [
    { url: "https://m.media-amazon.com/images/I/right.jpg", title: "Something else", trusted: true },
  ]), "https://m.media-amazon.com/images/I/right.jpg");
  assert.equal(chooseStockPhoto("STANDBY SHOE BOX 4PK", [
    { url: "https://gdx-assets.costco.com/box.avif", title: "Stackable Shoebox 4-pack" },
  ]), "https://gdx-assets.costco.com/box.avif");
  assert.equal(chooseStockPhoto("INSINKERATOR C3000", [
    { url: "https://www.insinkerator.com/resource/image/72796/portrait_ratio1x1/345/345/abc/.c3000.jpg", title: "Performance C3000 Garbage Disposal" },
  ]), "https://www.insinkerator.com/resource/image/72796/portrait_ratio1x1/345/345/abc/.c3000.jpg");
  assert.equal(chooseStockPhoto("EPSON ECOTANK ET3750SE", [
    { url: "https://mediaserver.goepson.com/adaptivemedia/rendition?id=et3750", title: "WorkForce ET-3750 EcoTank Printer" },
  ]), "https://mediaserver.goepson.com/adaptivemedia/rendition?id=et3750");
});

test("an unidentified photo does not pick a manifest line", () => {
  assert.equal(identityCanPick({ brand: "", title: "" }), false);
  assert.equal(identityCanPick({ brand: "Degree", title: "Degree Max Protection" }), true);
});

test("a category is kept only when its name fits the product", () => {
  assert.equal(categoryFits("Philips Sonicare Advanced Clean Electric Toothbrush", "Electric Toothbrushes"), true);
  assert.equal(categoryFits("Nikko RC 1:14 Elite Red Bull Race Car", "Posters & Prints"), false);
});
