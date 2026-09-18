import assert from "node:assert/strict";
import test from "node:test";
import {
  listingDescription,
  listingTitle,
  listedOnLabel,
  photoFileName,
  photoFolderName,
  spreadsheetRow,
  toCsv,
  toXlsx,
  type ExportUnit,
} from "./listing-export.ts";

const unit: ExportUnit = {
  sku: "11203",
  brand: "Whirlpool",
  model: "WRS325",
  title: "25 cu ft fridge",
  category: "Appliances",
  condition: "Open box",
  testStatus: "passed",
  defectNotes: "Small dent on left door.",
  askCents: 44900,
  msrpCents: 129900,
  state: "available",
  location: "Floor",
};

test("photo folders start with SKU and slug the model", () => {
  assert.equal(photoFolderName("11203", "Whirlpool", "WRS325"), "11203-whirlpool-wrs325");
  assert.equal(photoFileName("11203", 1), "11203-01.jpg");
  assert.equal(photoFileName("11203", 12), "11203-12.jpg");
});

test("listing copy is paste-ready and includes defects", () => {
  const title = listingTitle(unit);
  assert.match(title, /Whirlpool WRS325/);
  assert.match(title, /SKU 11203/);
  const body = listingDescription(unit);
  assert.match(body, /Ask: \$449\.00/);
  assert.match(body, /Small dent on left door/);
  assert.match(body, /Test status: passed/);
});

test("listed_on skips floor and sorts names", () => {
  assert.equal(listedOnLabel(["ebay", "floor", "facebook"]), "ebay, facebook");
});

test("csv and xlsx include the listing columns", () => {
  const row = spreadsheetRow({
    unit,
    listedOn: ["facebook"],
    photoFolder: "11203-whirlpool-wrs325",
    photoFiles: ["11203-01.jpg", "11203-02.jpg"],
  });
  const csv = toCsv([row]);
  assert.match(csv, /listing_title/);
  assert.match(csv, /11203-01\.jpg; 11203-02\.jpg/);
  assert.match(csv, /facebook/);
  const xlsx = toXlsx([row]);
  assert.ok(xlsx.length > 100);
  const head = String.fromCharCode(xlsx[0], xlsx[1], xlsx[2], xlsx[3]);
  assert.equal(head, "PK\u0003\u0004");
});
