import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptySkuLedger,
  markHardDeleted,
  nextSkuFromOccupied,
  rejectUsedSku,
  rememberSku,
  usedSkuMessage,
} from "./sku-ledger.ts";

test("used SKU message names the item and fate", () => {
  assert.equal(
    usedSkuMessage({
      sku: "11119",
      issuedAt: "2026-01-01",
      updatedAt: "2026-01-02",
      brand: "GE",
      model: "GTD45",
      title: "Dryer",
      fate: "sold",
    }),
    "SKU 11119 was already used for GE GTD45 (sold)",
  );
  assert.match(
    usedSkuMessage({
      sku: "11120",
      issuedAt: "2026-01-01",
      updatedAt: "2026-01-01",
      brand: "",
      model: "",
      title: "Washer",
      fate: "hard-deleted",
    }),
    /Washer \(hard-deleted\)/,
  );
});

test("hard-deleted SKUs stay occupied and are never revived", () => {
  const ledger = emptySkuLedger();
  rememberSku(ledger, { sku: "11111", brand: "LG", model: "A", title: "Fridge", fate: "issued" });
  markHardDeleted(ledger, { sku: "11111", brand: "LG", model: "A", title: "Fridge" });
  rememberSku(ledger, { sku: "11111", brand: "Other", model: "B", title: "Nope", fate: "issued" });
  assert.equal(ledger.entries["11111"].fate, "hard-deleted");
  assert.equal(ledger.entries["11111"].brand, "LG");
  assert.throws(() => rejectUsedSku(ledger, "11111"), /hard-deleted/);
});

test("retired SKUs stay occupied", () => {
  const ledger = emptySkuLedger();
  rememberSku(ledger, { sku: "11111", brand: "LG", model: "A", title: "Fridge", fate: "issued" });
  rememberSku(ledger, { sku: "11111", brand: "LG", model: "A", title: "Fridge", fate: "retired" });
  assert.throws(() => rejectUsedSku(ledger, "11111"), /changed to another SKU/);
});

test("next SKU skips every occupied serial, including deleted ones", () => {
  assert.equal(nextSkuFromOccupied(["11111", "11199"], 11111), "11200");
});
