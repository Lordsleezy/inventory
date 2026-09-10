import assert from "node:assert/strict";
import { test } from "node:test";
import type { Unit } from "./unit.ts";
import { belowFloorError, cannotSellReason, filterSaleHistory, saleTotals } from "./sale.ts";

function unit(overrides: Partial<Unit> = {}): Unit {
  return {
    sku: "11118",
    stockId: 10,
    brand: "Acme",
    model: "T100",
    title: "Washer",
    category: "Laundry",
    upc: "",
    sharedModelCount: 1,
    location: null,
    lot: null,
    state: "available",
    condition: "Good",
    testStatus: "untested",
    defectNotes: null,
    mfrSerial: null,
    acquisitionCostCents: null,
    msrpCents: null,
    retail: { cents: null, retailer: null, capturedOn: null },
    askCents: 5000,
    floorCents: 3000,
    listings: [],
    sale: null,
    voided: null,
    photoCount: 0,
    primaryAttachmentId: null,
    receivedOn: "",
    recordError: null,
    ...overrides,
  };
}

test("tax is rounded cents from basis points", () => {
  const totals = saleTotals({ linePriceCents: [10000], saleDiscountCents: 0, taxRateBps: 725 });
  assert.equal(totals.subtotalCents, 10000);
  assert.equal(totals.taxCents, 725);
  assert.equal(totals.totalCents, 10725);
});

test("sale discount applies before tax, never below zero", () => {
  const totals = saleTotals({ linePriceCents: [2500, 2500], saleDiscountCents: 6000, taxRateBps: 0 });
  assert.equal(totals.subtotalCents, 0);
  assert.equal(totals.taxCents, 0);
  assert.equal(totals.totalCents, 0);
});

test("staff cannot go below floor; admin needs confirm", () => {
  assert.equal(belowFloorError(4000, 5000, "staff", false)?.status, 403);
  assert.equal(belowFloorError(4000, 5000, "admin", false)?.status, 409);
  assert.equal(belowFloorError(4000, 5000, "admin", true), null);
  assert.equal(belowFloorError(5000, 5000, "staff", false), null);
  assert.equal(belowFloorError(4000, null, "staff", false), null);
});

test("sale history search matches sku, date, and customer", () => {
  const rows = [
    {
      id: 1,
      reference: "SO-0001",
      soldOn: "2026-09-04T12:00:00.000Z",
      channel: "floor",
      customerName: "Jane Doe",
      customerPhone: "9165550100",
      skus: ["11119"],
      lineSummary: "11119 Dryer",
      totalCents: 12000,
      receiptFile: null,
    },
  ];
  assert.equal(filterSaleHistory(rows, "11119").length, 1);
  assert.equal(filterSaleHistory(rows, "jane").length, 1);
  assert.equal(filterSaleHistory(rows, "2026-09-04").length, 1);
  assert.equal(filterSaleHistory(rows, "nobody").length, 0);
});

test("sold reserved voided repair are not sellable", () => {
  assert.match(cannotSellReason(unit({ state: "sold" })) ?? "", /sold/i);
  assert.match(cannotSellReason(unit({ state: "reserved" })) ?? "", /open sale/);
  assert.match(cannotSellReason(unit({ state: "voided" })) ?? "", /Voided/);
  assert.match(cannotSellReason(unit({ state: "repair" })) ?? "", /repair/);
  assert.equal(cannotSellReason(unit({ state: "available" })), null);
});
