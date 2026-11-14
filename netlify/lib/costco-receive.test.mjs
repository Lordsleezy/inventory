import test from "node:test";
import assert from "node:assert/strict";
import { buildCostcoReceive, candidateTitles, classifyCostcoLine, nearestManifestLine } from "./costco-receive.mjs";

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

test("a unique barcode within 3 digits suggests that line, and a tie does not", () => {
  const lines = [
    { upc_normalized: "079400536761", item_number: "2067097", description: "DEGREE MAX PROTECTION" },
    { upc_normalized: "079400513656", item_number: "1673482", description: "DOVE ADVANCED CARE" },
  ];
  assert.equal(nearestManifestLine("079400536762", lines).line.item_number, "2067097");
  assert.equal(nearestManifestLine("079400533746", lines), null);
});
