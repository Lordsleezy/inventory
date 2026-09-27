import assert from "node:assert/strict";
import test from "node:test";
import { cacheUnitRow } from "./cache.ts";

test("hydrate never copies cost or floor into the cache row", () => {
  const row = cacheUnitRow({
    sku: "10421",
    brand: "GE",
    ask_cents: 8900,
    acquisition_cost_cents: 4000,
    floor_cents: 5000,
    state: "available",
    received_at: "2026-01-01",
    updated_at: "2026-01-01",
  });
  assert.equal(row.acquisition_cost_cents, null);
  assert.equal(row.floor_cents, null);
  assert.equal(row.ask_cents, 8900);
});

test("hydrate keeps website listing flags and listing copy", () => {
  const row = cacheUnitRow({
    sku: "11171",
    ask_cents: 11900,
    listing_body: "Sump pump",
    listing_specs: { weight_lb: "18" },
    show_on_website: true,
    shippable: true,
    state: "available",
    received_at: "2026-09-25",
    updated_at: "2026-09-25",
  });
  assert.equal(row.show_on_website, true);
  assert.equal(row.shippable, true);
  assert.equal(row.listing_body, "Sump pump");
});

test("managers may keep cost in cache; staff path still strips", () => {
  const raw = {
    sku: "10421",
    ask_cents: 8900,
    acquisition_cost_cents: 4000,
    floor_cents: 5000,
  };
  const manager = cacheUnitRow(raw, { includeCost: true });
  assert.equal(manager.acquisition_cost_cents, 4000);
  assert.equal(manager.floor_cents, 5000);
  const staff = cacheUnitRow(raw, { includeCost: false });
  assert.equal(staff.acquisition_cost_cents, null);
  assert.equal(staff.floor_cents, null);
});
