import assert from "node:assert/strict";
import test from "node:test";
import { mapSellError, stripCostFromUnit } from "./sell.ts";

test("a second live sale is reported as a double-sale, never applied", () => {
  const err = mapSellError({ code: "23505", message: "duplicate key" });
  assert.equal(err.code, "double_sell");
  assert.match(err.message, /already has a live sale/i);
});

test("a sold or reserved unit is not sellable", () => {
  const err = mapSellError({ message: "unit_not_sellable" });
  assert.equal(err.code, "double_sell");
});

test("below-floor without approval is refused", () => {
  const err = mapSellError({ message: "below_floor" });
  assert.equal(err.code, "below_floor");
});

test("tax is integer cents from basis points, never a float dollars", () => {
  const price = 1999;
  const taxBps = 725;
  const tax = Math.round((price * taxBps) / 10_000);
  assert.equal(tax, 145);
});

test("staff cache rows never carry cost or floor", () => {
  const stripped = stripCostFromUnit({
    sku: "10000",
    ask_cents: 5000,
    acquisition_cost_cents: 1200,
    floor_cents: 3000,
  });
  assert.equal(stripped.ask_cents, 5000);
  assert.equal("acquisition_cost_cents" in stripped, false);
  assert.equal("floor_cents" in stripped, false);
  assert.equal(stripped.acquisitionCostCents, null);
  assert.equal(stripped.floorCents, null);
});
