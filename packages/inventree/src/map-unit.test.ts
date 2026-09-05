import assert from "node:assert/strict";
import { test } from "node:test";
import { isSellable } from "@floor/domain";
import { emptyEnvelope } from "./metadata.ts";
import { floorStateFromStatus, STOCK_STATUS } from "./status.ts";
import { stockListToUnits, stockToUnit, type InventreeStock } from "./map-unit.ts";

function stock(overrides: Partial<InventreeStock> = {}): InventreeStock {
  return {
    pk: 1,
    serial: "11111",
    batch: "WAVE-0",
    purchase_price: null,
    status: 10,
    metadata: { lros: emptyEnvelope() },
    ...overrides,
  };
}

test("OK status is available", () => {
  const unit = stockToUnit(stock());
  assert.equal(unit.state, "available");
  assert.equal(unit.recordError, null);
  assert.equal(isSellable(unit), true);
});

test("allocated OK status is reserved, not available", () => {
  const unit = stockToUnit(stock({ allocated: true }));
  assert.equal(unit.state, "reserved");
  assert.equal(isSellable(unit), false);
});

test("shipped stock with a sales order is sold even without sale metadata", () => {
  const unit = stockToUnit(stock({ in_stock: false, sales_order: 3, allocated: 1 }));
  assert.equal(unit.state, "sold");
  assert.equal(isSellable(unit), false);
});

test("status 70 Lost is lost, never available", () => {
  const unit = stockToUnit(stock({ status: STOCK_STATUS.LOST }));
  assert.equal(unit.state, "lost");
  assert.equal(isSellable(unit), false);
});

test("status 65 Rejected is voided, not scrapped", () => {
  const unit = stockToUnit(stock({ status: STOCK_STATUS.REJECTED }));
  assert.equal(unit.state, "voided");
  assert.equal(isSellable(unit), false);
});

test("status 60 Destroyed is scrapped", () => {
  const unit = stockToUnit(stock({ status: STOCK_STATUS.DESTROYED }));
  assert.equal(unit.state, "scrapped");
});

test("unrecognized status is repair with an error, not available", () => {
  const unit = stockToUnit(stock({ status: 999 }));
  assert.equal(unit.state, "repair");
  assert.match(unit.recordError ?? "", /unrecognized stock status 999/);
  assert.equal(isSellable(unit), false);
});

test("unreadable status is repair", () => {
  const result = floorStateFromStatus("nope", false);
  assert.equal(result.state, "repair");
  assert.match(result.error ?? "", /unreadable/);
});

test("corrupt metadata marks the unit and does not throw", () => {
  const units = stockListToUnits([
    stock({ serial: "11111" }),
    stock({
      pk: 2,
      serial: "11112",
      metadata: { lros: { askCents: "not-cents" } },
    }),
    stock({ pk: 3, serial: "11113", status: 10, metadata: { lros: { ...emptyEnvelope(), askCents: 145000, condition: "Excellent" } } }),
  ]);
  assert.equal(units.length, 3);
  assert.equal(units[0].state, "available");
  assert.equal(units[1].state, "repair");
  assert.match(units[1].recordError ?? "", /corrupt lros metadata/);
  assert.equal(units[2].askCents, 145000);
  assert.equal(units[2].condition, "Excellent");
});

test("empty ask stays null", () => {
  const unit = stockToUnit(stock());
  assert.equal(unit.askCents, null);
  assert.equal(unit.acquisitionCostCents, null);
});

test("brand comes from part metadata, never the first word of the name", () => {
  const unit = stockToUnit(
    stock({
      part_detail: {
        name: "LG LRFLC2716S",
        IPN: "LRFLC2716S",
        description: "French-door refrigerator",
        metadata: { lros: { brand: "LG" } },
      },
    }),
  );
  assert.equal(unit.brand, "LG");
  assert.equal(unit.model, "LRFLC2716S");
  assert.equal(unit.title, "French-door refrigerator");
  assert.equal(unit.upc, "");
});

test("UPC comes from part metadata", () => {
  const unit = stockToUnit(
    stock({
      part_detail: {
        name: "LG LRFLC2716S",
        IPN: "LRFLC2716S",
        description: "French-door refrigerator",
        metadata: { lros: { brand: "LG", upc: "048231123456" } },
      },
    }),
  );
  assert.equal(unit.upc, "048231123456");
});
