import assert from "node:assert/strict";
import { test } from "node:test";
import { filterUnits } from "./search.ts";
import type { Unit } from "./unit.ts";

const listings: Unit["listings"] = [
  { channel: "ebay", state: "NOT_LISTED", url: null, listedOn: null },
  { channel: "facebook", state: "NOT_LISTED", url: null, listedOn: null },
  { channel: "tiktok", state: "NOT_LISTED", url: null, listedOn: null },
  { channel: "amazon", state: "NOT_LISTED", url: null, listedOn: null },
];

function unit(overrides: Partial<Unit>): Unit {
  return {
    sku: "11111",
    brand: "LG",
    model: "LRFLC2716S",
    title: "French-door refrigerator",
    category: "",
    upc: "",
    sharedModelCount: 1,
    location: null,
    lot: "WAVE-0",
    state: "available",
    condition: null,
    testStatus: "untested",
    defectNotes: null,
    mfrSerial: null,
    acquisitionCostCents: null,
    msrpCents: null,
    retail: { cents: null, retailer: null, capturedOn: null },
    askCents: null,
    floorCents: null,
    listings,
    sale: null,
    voided: null,
    photoCount: 0,
    primaryAttachmentId: null,
    receivedOn: "",
    recordError: null,
    stockId: 1,
    ...overrides,
  };
}

test("search matches sku and model, ignores non-SKU rows", () => {
  const units = [
    unit({ sku: "11113", model: "LRFLC2716S", condition: "Excellent", askCents: 145000 }),
    unit({ sku: "pk-9", model: "junk" }),
  ];
  assert.equal(filterUnits(units, { q: "11113" }).map((u) => u.sku).join(), "11113");
  assert.equal(filterUnits(units, { q: "lrflc" }).map((u) => u.sku).join(), "11113");
});

test("inspect queue is missing condition", () => {
  const units = [
    unit({ sku: "11111", condition: null }),
    unit({ sku: "11113", condition: "Excellent" }),
  ];
  assert.deepEqual(filterUnits(units, { queue: "inspect" }).map((u) => u.sku), ["11111"]);
});

test("price queue is missing ask", () => {
  const units = [
    unit({ sku: "11112", condition: "Good", askCents: null }),
    unit({ sku: "11113", condition: "Excellent", askCents: 145000 }),
  ];
  assert.deepEqual(filterUnits(units, { queue: "price" }).map((u) => u.sku), ["11112"]);
});

test("unlisted queue is priced and not listed", () => {
  const listed = listings.map((row) => (row.channel === "ebay" ? { ...row, state: "LISTED" as const } : row));
  const units = [
    unit({ sku: "11113", askCents: 145000 }),
    unit({ sku: "11114", askCents: 99000, listings: listed }),
    unit({ sku: "11112", askCents: null }),
  ];
  assert.deepEqual(filterUnits(units, { queue: "unlisted" }).map((u) => u.sku), ["11113"]);
});

test("error queue is recordError set", () => {
  const units = [
    unit({ sku: "11111", recordError: null }),
    unit({ sku: "11115", recordError: "corrupt lros metadata" }),
  ];
  assert.deepEqual(filterUnits(units, { queue: "error" }).map((u) => u.sku), ["11115"]);
});

test("voided units are excluded unless the voided queue is asked", () => {
  const units = [
    unit({ sku: "11111", state: "available" }),
    unit({ sku: "11112", state: "voided" }),
  ];
  assert.deepEqual(filterUnits(units, {}).map((u) => u.sku), ["11111"]);
  assert.deepEqual(filterUnits(units, { queue: "voided" }).map((u) => u.sku), ["11112"]);
  assert.deepEqual(filterUnits(units, { includeVoided: true }).map((u) => u.sku), ["11111", "11112"]);
});
