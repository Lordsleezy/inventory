import test from "node:test";
import assert from "node:assert/strict";
import { buildCostcoReceive, candidateTitles, classifyCostcoLine, manifestItemFromText, nearestManifestLine, stockImagesForLine } from "./costco-receive.mjs";
import { chooseCatalogStockPhotos } from "./stock-photo-match.mjs";
import { keepStockPhoto } from "./stock-photo.mjs";

const line = {
  tcin: "3858210",
  upc_raw: "075020108296",
  upc_normalized: "075020108296",
  description: "SONICARE ADVANCED CLEAN",
  brand: "Philips Sonicare",
  condition: "USED_GOOD",
  unit_retail_cents: 8999,
};

test("variant titles come from the stored tie, not a stale catalog title", () => {
  const why = "Several Amazon results match: Philips Sonicare Optimal Clean Rechargeable Electric Toothbrush, 2-pack | Philips Sonicare 4100 Rechargeable Electric Toothbrush, 1 Brush Head, White | Philips Sonicare 4100 Rechargeable Electric Toothbrush, 1 Brush Head, Black";
  const card = buildCostcoReceive({
    line,
    enrich: { status: "partial", why },
    product: { title: "Philips Sonicare Professional Clean Plus Electric Toothbrush Set White/Blue", brand: "Philips Sonicare", images: [] },
    amazon: { found: false },
  });
  assert.equal(card.receive.bucket, "ready");
  assert.equal(card.receive.photo, false);
  assert.equal(card.receive.candidates.length, 0);
  assert.equal(card.merged.title.includes("Professional Clean Plus"), false);
  assert.match(card.merged.title, /ADVANCED CLEAN/i);
  assert.equal(card.amazon.skipped, "prewarmed");
  assert.equal(card.receive.condition_hint, "");
  assert.equal(card.receive.manifest_retail_cents, 8999);
});

test("an exact barcode product fills and does not ask for a photo match", () => {
  const card = buildCostcoReceive({
    line: { ...line, tcin: "3239377", description: "SONICARE DIAMONDCLEAN" },
    enrich: { status: "confirmed", via: "manifest_plus_barcode", variant_note: "Barcode pack 2" },
    product: {
      title: "Sonicare Diamond Clean 2-Pack Handles Black",
      brand: "PHILIPS",
      model: "HX9913/71",
      images: ["https://m.media-amazon.com/images/I/diamond.jpg"],
      package_length_in: 15.3,
      package_width_in: 14.25,
      package_height_in: 4.1,
      package_weight_lb: 4.55,
      features: ["Two handles"],
      aspects: { pack_count: 2 },
    },
    amazon: { found: true, identifier_match: true },
  });
  assert.equal(card.receive.bucket, "ready");
  assert.equal(card.receive.photo, false);
  assert.equal(card.receive.pack_count, 2);
  assert.equal(card.merged.package.length_in, 15.3);
  assert.equal(card.merged.package.weight_lb, 4.55);
  assert.equal(card.stock_photos.length, 1);
});

test("no Amazon match keeps the manifest identity and opens the photo step", () => {
  const card = buildCostcoReceive({
    line: { ...line, tcin: "1901761", description: "MESA 2 TIER ORGANIZER", brand: "Mesa" },
    enrich: { status: "missing", why: "Amazon catalog has no matching product" },
    product: { title: "Mesa 2 tier black organizer — New", brand: "Mesa", images: [] },
    amazon: { found: false },
  });
  assert.equal(card.receive.bucket, "ready");
  assert.equal(card.receive.photo, false);
  assert.match(card.merged.title, /MESA 2 TIER ORGANIZER/);
  assert.equal(card.merged.images.length, 0);
});

test("a 4999 sticker is never a GTIN", () => {
  const card = buildCostcoReceive({
    line: {
      tcin: "2027861",
      upc_raw: "499912345678",
      upc_normalized: "499912345678",
      description: "PUMA UNLIMITED BACKPACK",
      brand: "Puma",
      condition: "USED_GOOD",
      unit_retail_cents: 3999,
    },
    enrich: { status: "partial", why: "Several Amazon results match: PUMA Unlimited Backpack, Black, with Exterior Pockets and Interior Zip and Slip Pockets | PUMA Unlimited Backpack, Green, with Exterior Pockets and Interior Zip and Slip Pockets" },
  });
  assert.equal(card.gtin, null);
  assert.equal(card.receive.internal, true);
  assert.equal(card.receive.bucket, "ready");
  assert.equal(card.receive.candidates.length, 0);
  assert.match(card.merged.title, /PUMA UNLIMITED BACKPACK/);
});

test("open conflicts stay on the card and a saved answer is returned", () => {
  const koda = buildCostcoReceive({
    line: { ...line, tcin: "1937993", description: "KODA 5000L SECURITY LIGHT", brand: "" },
    enrich: { status: "partial", why: "Amazon catalog matches. No second independent page yet.", conflicts: [{ field: "lumens", values: ["5000", "3600"] }] },
    product: { title: "Koda floodlight", brand: "Koda", images: ["https://m.media-amazon.com/images/I/koda.jpg"], package_weight_lb: 3.5 },
    amazon: { found: true, title: "Koda floodlight" },
  });
  assert.equal(koda.receive.bucket, "ready");
  assert.equal(koda.receive.conflict.field, "lumens");
  assert.match(koda.receive.conflict.note, /5000/);
  const saved = buildCostcoReceive({
    line: { ...line, tcin: "1937993", description: "KODA 5000L SECURITY LIGHT" },
    enrich: { resolved: { lumens: "5000" } },
    product: { title: "Koda floodlight", brand: "Koda", aspects: { resolved: { lumens: "5000" } } },
    amazon: { found: true, title: "Koda floodlight" },
  });
  assert.equal(saved.receive.conflict.saved, "5000");
});

test("clerks do not receive manifest retail", () => {
  const card = buildCostcoReceive({ line, enrich: { status: "missing", why: "Amazon catalog has no matching product" }, stripMoney: true });
  assert.equal(card.receive.manifest_retail_cents, null);
});

test("a pinned title does not show the picker again", () => {
  const decision = classifyCostcoLine({
    line,
    enrich: { status: "partial", why: candidateTitles.length ? "" : "Several Amazon results match: One long title here | Two long title here", pinned_title: "Philips Sonicare 4100 Rechargeable Electric Toothbrush, 1 Brush Head, White" },
    product: { title: "Philips Sonicare 4100 Rechargeable Electric Toothbrush, 1 Brush Head, White", aspects: { pinned_title: "Philips Sonicare 4100 Rechargeable Electric Toothbrush, 1 Brush Head, White" } },
  });
  assert.equal(decision.bucket, "ready");
  assert.equal(decision.candidates.length, 0);
});

test("candidate parser keeps each stored title", () => {
  assert.deepEqual(candidateTitles("Several Amazon results match: Alpha toothbrush model one | Beta toothbrush model two"), [
    "Alpha toothbrush model one",
    "Beta toothbrush model two",
  ]);
});

test("an expanded name replaces the truncated manifest stub without overriding the manifest brand", () => {
  const card = buildCostcoReceive({
    line,
    enrich: { expanded_title: "Sharper Image Rolling Massager", expanded_brand: "Sharper Image", ebay_category_id: "20713" },
  });
  assert.match(card.merged.title, /Rolling Massager/);
  assert.equal(card.merged.brand, "Philips Sonicare");
  assert.equal(card.receive.ebay_category_id, null);
});

test("a box saved for this barcode fills even when the catalog title is not trusted", () => {
  const card = buildCostcoReceive({
    line: { ...line, description: "INFINITY X1 UNDER CABINET LIGHT" },
    enrich: { status: "partial", why: "Several Amazon results match: Infinity light one | Infinity light two" },
    product: {
      title: "Some other light",
      package_length_in: 10.47,
      package_width_in: 10.12,
      package_height_in: 2.91,
      package_weight_lb: 2.27,
      dim_sources: { length_in: "published", width_in: "published", height_in: "published", weight_lb: "published" },
    },
    amazon: { found: true, identifier_match: false, title: "Some other light", package: { length_in: 99, width_in: 99, height_in: 99, weight_lb: 99 } },
  });
  assert.match(card.merged.title, /INFINITY X1/);
  assert.equal(card.merged.title.includes("other light"), false);
  assert.deepEqual(card.merged.package, { length_in: 10.47, width_in: 10.12, height_in: 2.91, weight_lb: 2.27 });
});

test("an untrusted catalog box fills when this barcode has no saved box", () => {
  const card = buildCostcoReceive({
    line: { ...line, tcin: "1848535", item_number: "1848535", description: "KOHLER TERZET WIDE BNCKEL", upc_normalized: "195711178039" },
    enrich: { status: "partial", why: "Several Amazon results match: faucet one | faucet two" },
    product: { title: "Kohler KOHLER TERZET WIDE BNCKEL", package_length_in: null, dim_sources: {} },
    amazon: {
      found: true,
      identifier_match: false,
      title: "Kohler Terzet Widespread Bathroom Sink Faucet",
      package: { length_in: 22.68, width_in: 9.76, height_in: 3.7, weight_lb: 3.68 },
      item: { length_in: 18, width_in: 18, height_in: 18, weight_lb: 3 },
    },
  });
  assert.match(card.merged.title, /KOHLER TERZET/);
  assert.equal(card.merged.title.includes("Widespread"), false);
  assert.deepEqual(card.merged.package, { length_in: 22.68, width_in: 9.76, height_in: 3.7, weight_lb: 3.68 });
  assert.equal(card.merged.aspects.product_height_in, undefined);
});

test("the item's own size is kept when the shipping box is unknown", () => {
  const card = buildCostcoReceive({
    line: { ...line, description: "LED FEIT 100W GLASS A21 5", brand: "Feit" },
    enrich: { status: "partial", why: "Several Amazon results match: bulb one | bulb two" },
    product: { title: "Some other bulb" },
    amazon: {
      found: true,
      identifier_match: false,
      title: "Feit Electric 100W Replacement Bulbs",
      item: { length_in: 4.7, width_in: 2.4, height_in: 2.4, weight_lb: 0.4 },
    },
  });
  assert.match(card.merged.title, /FEIT/);
  assert.equal(card.merged.aspects.product_depth_in, "4.7");
  assert.equal(card.merged.aspects.product_width_in, "2.4");
  assert.equal(card.merged.aspects.product_height_in, "2.4");
  assert.equal(card.merged.aspects.product_weight_lb, "0.4");
  assert.equal(card.merged.package.length_in, null);
});

test("a listed package fills a side the catalog left blank", () => {
  const card = buildCostcoReceive({
    line,
    product: { title: "Philips Sonicare" },
    amazon: { found: true, identifier_match: false, package: { length_in: 8, width_in: 3, height_in: 2, weight_lb: null } },
    upcitemdb: { package: { weight_lb: 1.2 } },
  });
  assert.deepEqual(card.merged.package, { length_in: 8, width_in: 3, height_in: 2, weight_lb: 1.2 });
});

test("a Costco page names one manifest item, and two names name none", () => {
  const numbers = ["1848535", "1781269"];
  assert.equal(manifestItemFromText('https://www.costco.com/p/-/kohler-terzet/4000287300 "sku":"1848535" Item 1848535', numbers), "1848535");
  assert.equal(manifestItemFromText("Item 1848535 and Item 1781269", numbers), null);
  assert.equal(manifestItemFromText("Item 9999999", numbers), null);
});

test("an estimated box is not treated as a measurement", () => {
  const card = buildCostcoReceive({
    line,
    product: { package_length_in: 9, package_weight_lb: 4, dim_sources: { length_in: "estimated", weight_lb: "gemini" } },
    amazon: { found: false },
  });
  assert.equal(card.merged.package.length_in, null);
  assert.equal(card.merged.package.weight_lb, null);
});

test("a catalog title that only borrows the manifest words is not a stock photo", () => {
  const images = stockImagesForLine({
    line: { description: "DISNEY HALLOWEEN VILLAGE", brand: "" },
    product: { title: "MOMENTS IN TIME Disney Halloween Village 12-Piece", images: ["https://m.media-amazon.com/images/I/wrong.jpg"] },
    amazon: { identifier_match: false },
    expandedTitle: "Disney Halloween Village, 12-piece Set",
  });
  assert.deepEqual(images, []);
});

test("a fuzzy catalog photo is not the stock photo, and a stored match is", () => {
  const images = stockImagesForLine({
    line,
    enrich: { images: ["https://i.ebayimg.com/images/g/disney.jpg"] },
    product: { title: "Moments in Time", images: ["https://m.media-amazon.com/images/I/wrong.jpg"] },
    amazon: { found: true, identifier_match: false },
    expandedTitle: "Disney Halloween Village",
  });
  assert.deepEqual(images, ["https://i.ebayimg.com/images/g/disney.jpg"]);
});

test("a unique barcode within 3 digits suggests that line, and a tie does not", () => {
  const lines = [
    { upc_normalized: "079400536761", item_number: "2067097", description: "DEGREE MAX PROTECTION" },
    { upc_normalized: "079400513656", item_number: "1673482", description: "DOVE ADVANCED CARE" },
  ];
  assert.equal(nearestManifestLine("079400536762", lines).line.item_number, "2067097");
  assert.equal(nearestManifestLine("079400533746", lines), null);
});

test("a brand-matching catalog photo is kept and a replacement is not", () => {
  const images = chooseCatalogStockPhotos({
    brand: "Jolie",
    title: "Jolie The Filtered Showerhead",
    catalogs: [
      { brand: "Generic", title: "Replacement Filter for the Jolie Showerhead", images: ["https://m.media-amazon.com/images/I/filter.jpg"] },
      { brand: "Jolie Skin Company", title: "Jolie Filtered Showerhead, High Pressure", images: ["https://m.media-amazon.com/images/I/jolie.jpg"] },
    ],
  });
  assert.deepEqual(images, ["https://m.media-amazon.com/images/I/jolie.jpg"]);
});

test("a different color is not used as the stock photo", () => {
  const images = chooseCatalogStockPhotos({
    brand: "Jolie",
    title: "Jolie Filtered Showerhead",
    color: "gold",
    catalogs: [{ brand: "Jolie", title: "Jolie Filtered Showerhead Jet Black", images: ["https://m.media-amazon.com/images/I/black.jpg"] }],
  });
  assert.deepEqual(images, []);
});

test("another product's size is not saved as this item's box", () => {
  const card = buildCostcoReceive({
    line: { ...line, description: "FOSTER GRANT 668 READING GLASSES", brand: "Foster Grant", upc_normalized: "0193033762301" },
    enrich: { expanded_title: "Foster Grant Design Optics Metal Square Reading Glasses, 3-Pack" },
    product: {
      title: "3-Piece Square Dining Table Set",
      brand: "AF ARTISAN FURNITURE",
      aspects: { item_dims: { length_in: 39.76, width_in: 39.76, height_in: 4.33, weight_lb: 80 } },
    },
    amazon: {
      found: true,
      identifier_match: false,
      title: "3-Piece Square Dining Table Set",
      brand: "AF ARTISAN FURNITURE",
      item: { length_in: 39.76, width_in: 39.76, height_in: 4.33, weight_lb: 80 },
      package: { length_in: 40, width_in: 40, height_in: 5, weight_lb: 80 },
    },
  });
  assert.match(card.merged.title, /Foster Grant/);
  assert.equal(card.merged.package.weight_lb, null);
  assert.equal(card.merged.package.length_in, null);
  assert.equal(card.merged.aspects.product_weight_lb, undefined);
  assert.equal(card.merged.aspects.product_depth_in, undefined);
});

test("Costco's own photo is kept and another seller's photo is not", () => {
  assert.equal(keepStockPhoto({ url: "https://bfasset.costco-static.com/a.jpg", source: "costco" }), true);
  assert.equal(keepStockPhoto({ url: "https://i.ebayimg.com/images/g/seller.jpg", source: "costco" }), false);
  assert.equal(keepStockPhoto("https://i5.walmartimages.com/asr/jerky.jpeg"), false);
  assert.equal(keepStockPhoto({ url: "https://m.media-amazon.com/images/I/a.jpg", source: "amazon" }), true);
});
