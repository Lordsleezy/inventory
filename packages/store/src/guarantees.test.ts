import assert from "node:assert/strict";
import test from "node:test";

import { openNodeDb } from "./driver-node.ts";
import { exportSnapshot, restoreSnapshot } from "./backup.ts";
import { FloorError, type Db } from "./db.ts";
import {
  deleteUnit,
  initDb,
  listUnits,
  loadUnit,
  nextSku,
  receiveUnit,
  reports,
  saleForSku,
  salesHistory,
  sellUnit,
  setUnitState,
  unitHistory,
  updateUnit,
  voidSale,
} from "./store.ts";

async function fresh(): Promise<Db> {
  const db = openNodeDb(":memory:");
  await initDb(db);
  return db;
}

async function rejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected this to be refused, but it succeeded");
}

// ===========================================================================
// A unit cannot sell twice.
// ===========================================================================

test("a unit cannot be sold twice", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Whirlpool", model: "WRF535", askCents: 45000 });

  const first = await sellUnit(db, { sku: unit.sku, priceCents: 40000, channel: "floor" });
  assert.equal(first.priceCents, 40000);

  const err = await rejects(() => sellUnit(db, { sku: unit.sku, priceCents: 39900, channel: "ebay" }));
  assert.ok(err instanceof FloorError, `expected a FloorError, got ${err.name}`);
  assert.ok(
    err.code === "already_sold" || err.code === "not_sellable",
    `refused for the wrong reason: ${err.code}`,
  );

  const live = await db.all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sales WHERE sku = ? AND voided_at IS NULL",
    [unit.sku],
  );
  assert.equal(Number(live[0].n), 1, "there must be exactly one live sale");

  const after = await loadUnit(db, unit.sku);
  assert.equal(after?.state, "sold");
  await db.close();
});

test("the unique index refuses a second sale even with the state guard removed", async () => {
  // The trigger is a convenience that produces a good error message. The
  // partial unique index is the actual guarantee, so prove it on its own.
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "DeWalt", model: "DCD771" });
  await sellUnit(db, { sku: unit.sku, priceCents: 8900, channel: "floor" });

  await db.exec("DROP TRIGGER sales_unit_must_be_sellable");
  await db.exec("DROP TRIGGER units_sold_needs_a_sale");
  await db.exec("DROP TRIGGER units_sold_stays_sold");
  await db.run("UPDATE units SET state = 'available' WHERE sku = ?", [unit.sku]);

  const err = await rejects(() =>
    db.run(
      `INSERT INTO sales(sku, price_cents, channel, sold_at, receipt_no)
       VALUES (?, 1, 'ebay', '2026-01-01T00:00:00.000Z', 'R-RAW')`,
      [unit.sku],
    ),
  );
  assert.match(err.message, /UNIQUE constraint failed/, `index did not fire: ${err.message}`);
  await db.close();
});

test("two sales in flight for one SKU: exactly one wins", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Samsung", model: "RF28" });

  const results = await Promise.allSettled([
    sellUnit(db, { sku: unit.sku, priceCents: 50000, channel: "floor" }),
    sellUnit(db, { sku: unit.sku, priceCents: 48000, channel: "ebay" }),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  await db.close();
});

test("a voided sale releases the unit, and it can then be sold again", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "LG", model: "WM3900" });
  const sale = await sellUnit(db, { sku: unit.sku, priceCents: 30000, channel: "floor" });

  await voidSale(db, sale.id, "customer backed out");
  assert.equal((await loadUnit(db, unit.sku))?.state, "available");
  assert.equal(await saleForSku(db, unit.sku), null);

  const resold = await sellUnit(db, { sku: unit.sku, priceCents: 28000, channel: "offerup" });
  assert.equal(resold.priceCents, 28000);

  const all = await salesHistory(db, { includeVoided: true });
  assert.equal(all.length, 2, "the voided sale is still on the record");
  await db.close();
});

test("a voided sale cannot be un-voided, edited or deleted", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Bosch", model: "SHPM" });
  const sale = await sellUnit(db, { sku: unit.sku, priceCents: 20000, channel: "floor" });

  const edit = await rejects(() =>
    db.run("UPDATE sales SET price_cents = 1 WHERE id = ?", [sale.id]),
  );
  assert.match(edit.message, /cannot be edited/);

  const gone = await rejects(() => db.run("DELETE FROM sales WHERE id = ?", [sale.id]));
  assert.match(gone.message, /voided, never deleted/);

  await voidSale(db, sale.id, "mistake");
  const unvoid = await rejects(() =>
    db.run("UPDATE sales SET voided_at = NULL WHERE id = ?", [sale.id]),
  );
  assert.match(unvoid.message, /stays voided/);
  await db.close();
});

test("a unit cannot be marked sold without a sale behind it", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "GE", model: "GTW335" });
  const err = await rejects(() => setUnitState(db, unit.sku, "sold"));
  assert.match(err.message, /cannot be marked sold without a sale/);
  await db.close();
});

test("a sold unit cannot be deleted or quietly moved back to stock", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Maytag", model: "MVW" });
  await sellUnit(db, { sku: unit.sku, priceCents: 15000, channel: "floor" });

  assert.match((await rejects(() => deleteUnit(db, unit.sku))).message, /[Vv]oid the sale/);
  assert.match((await rejects(() => setUnitState(db, unit.sku, "available"))).message, /[Vv]oid the sale/);
  await db.close();
});

// ===========================================================================
// SKU is identity, and is never reused.
// ===========================================================================

test("a SKU is never reissued, even after the unit is hard deleted", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Frigidaire", model: "FFTR" });
  assert.equal(unit.sku, "10000");

  await deleteUnit(db, unit.sku);
  assert.equal(await loadUnit(db, unit.sku), null, "the unit is gone");

  const err = await rejects(() => receiveUnit(db, { sku: unit.sku, brand: "Anything" }));
  assert.ok(err instanceof FloorError && err.code === "sku_taken", err.message);

  assert.equal(await nextSku(db), "10001", "the number is spent, not recycled");

  const ledger = await db.all<{ fate: string }>("SELECT fate FROM sku_ledger WHERE sku = ?", [unit.sku]);
  assert.equal(ledger[0].fate, "hard-deleted");
  await db.close();
});

test("SKU ledger rows cannot be deleted", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Kenmore" });
  await deleteUnit(db, unit.sku);
  const err = await rejects(() => db.run("DELETE FROM sku_ledger WHERE sku = ?", [unit.sku]));
  assert.match(err.message, /never freed/);
  await db.close();
});

test("SKUs are five digits and issued in sequence", async () => {
  const db = await fresh();
  const a = await receiveUnit(db, { brand: "A" });
  const b = await receiveUnit(db, { brand: "B" });
  assert.equal(a.sku, "10000");
  assert.equal(b.sku, "10001");
  assert.match(a.sku, /^\d{5}$/);

  const manual = await receiveUnit(db, { sku: "20500", brand: "C" });
  assert.equal(manual.sku, "20500");
  assert.equal(await nextSku(db), "20501", "sequence follows the highest ever issued");

  const bad = await rejects(() => receiveUnit(db, { sku: "123", brand: "D" }));
  assert.match(bad.message, /five digits/);
  await db.close();
});

// ===========================================================================
// One of one. There is no quantity, anywhere.
// ===========================================================================

test("no table has a quantity column, and identical items are separate records", async () => {
  const db = await fresh();
  for (const table of ["units", "sales", "sku_ledger", "events", "photos"]) {
    const cols = await db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
    const names = cols.map((c) => c.name);
    assert.equal(names.length > 0, true, `${table} should exist`);
    for (const banned of ["quantity", "qty", "count", "stock"]) {
      assert.ok(!names.includes(banned), `${table} must not have a ${banned} column`);
    }
  }

  // Five identical refrigerators.
  const skus: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const u = await receiveUnit(db, { brand: "Whirlpool", model: "WRF535", askCents: 45000 });
    skus.push(u.sku);
  }
  assert.equal(new Set(skus).size, 5, "five things, five SKUs");

  // Each one carries its own condition, price and fate.
  await updateUnit(db, skus[0], { condition: "Excellent", ask_cents: 50000 });
  await updateUnit(db, skus[1], { condition: "For parts", ask_cents: 12000 });
  await sellUnit(db, { sku: skus[2], priceCents: 44000, channel: "floor" });

  assert.equal((await loadUnit(db, skus[0]))?.askCents, 50000);
  assert.equal((await loadUnit(db, skus[1]))?.condition, "For parts");
  assert.equal((await loadUnit(db, skus[2]))?.state, "sold");
  assert.equal((await loadUnit(db, skus[3]))?.state, "available");
  await db.close();
});

// ===========================================================================
// History is never rewritten.
// ===========================================================================

test("audit rows cannot be updated or deleted", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Hoover" });
  await updateUnit(db, unit.sku, { ask_cents: 9900 });

  const rows = await unitHistory(db, unit.sku);
  assert.ok(rows.length >= 2);

  const upd = await rejects(() => db.run("UPDATE events SET note = 'x' WHERE id = ?", [rows[0].id]));
  assert.match(upd.message, /never rewritten/);

  const del = await rejects(() => db.run("DELETE FROM events WHERE id = ?", [rows[0].id]));
  assert.match(del.message, /never deleted/);
  await db.close();
});

test("every price, condition, status and location change is recorded with a timestamp", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Ryobi", model: "P1813", condition: "Good" });

  await updateUnit(db, unit.sku, { ask_cents: 12900 });
  await updateUnit(db, unit.sku, { ask_cents: 9900 });
  await updateUnit(db, unit.sku, { condition: "Fair" });
  await updateUnit(db, unit.sku, { location: "Back room" });
  await updateUnit(db, unit.sku, { test_status: "passed" });
  await setUnitState(db, unit.sku, "repair", "floor", "motor rattle");

  const history = await unitHistory(db, unit.sku);
  const fields = history.map((h) => h.field);
  for (const expected of ["ask", "condition", "location", "test status", "state"]) {
    assert.ok(fields.includes(expected), `missing an audit row for ${expected}`);
  }

  const priceRows = history.filter((h) => h.field === "ask");
  assert.equal(priceRows.length, 2, "both price moves are kept, not just the latest");
  const older = priceRows.find((r) => r.newValue === "12900");
  assert.ok(older, "the superseded price is still on the record");
  for (const row of history) assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/);
  await db.close();
});

test("deleting a unit leaves its history behind", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Milwaukee" });
  await updateUnit(db, unit.sku, { ask_cents: 19900 });
  await deleteUnit(db, unit.sku);

  const history = await unitHistory(db, unit.sku);
  assert.ok(history.length >= 3, "receive, edit and delete are all still there");
  assert.ok(history.some((h) => h.kind === "deleted"));
  await db.close();
});

// ===========================================================================
// Money in integer cents, and blank is not zero.
// ===========================================================================

test("an unpriced unit stays unpriced and never becomes zero", async () => {
  const db = await fresh();
  const unit = await receiveUnit(db, { brand: "Ridgid" });
  assert.equal(unit.askCents, null);
  assert.equal(unit.msrpCents, null);
  assert.equal(unit.acquisitionCostCents, null);

  const priced = await updateUnit(db, unit.sku, { ask_cents: 4550 });
  assert.equal(priced.askCents, 4550);

  const cleared = await updateUnit(db, unit.sku, { ask_cents: null });
  assert.equal(cleared.askCents, null, "clearing a price restores blank, not zero");

  const zeroed = await updateUnit(db, unit.sku, { ask_cents: 0 });
  assert.equal(zeroed.askCents, 0, "an explicit zero is still allowed and is distinct from blank");

  const bad = await rejects(() => db.run("UPDATE units SET ask_cents = -1 WHERE sku = ?", [unit.sku]));
  assert.match(bad.message, /CHECK constraint failed/);
  await db.close();
});

// ===========================================================================
// Nothing is hardcoded to appliances.
// ===========================================================================

test("a pallet of power tools works with no schema change", async () => {
  const db = await fresh();
  await db.run("UPDATE settings SET value = ? WHERE key = 'categories'", [
    JSON.stringify(["Power tools", "Hand tools", "Batteries"]),
  ]);
  await db.run("UPDATE settings SET value = ? WHERE key = 'conditions'", [
    JSON.stringify(["Sealed", "Tool only", "Missing battery"]),
  ]);
  await db.run("UPDATE settings SET value = ? WHERE key = 'channels'", [
    JSON.stringify(["swap meet", "mercari"]),
  ]);

  const drill = await receiveUnit(db, {
    brand: "Makita",
    model: "XFD131",
    category: "Power tools",
    condition: "Tool only",
    lot: "pallet-44",
    askCents: 7900,
  });
  const sale = await sellUnit(db, { sku: drill.sku, priceCents: 7500, channel: "swap meet" });

  assert.equal(sale.channel, "swap meet");
  assert.equal((await loadUnit(db, drill.sku))?.category, "Power tools");
  await db.close();
});

// ===========================================================================
// Search and reports.
// ===========================================================================

test("search matches SKU, brand and model", async () => {
  const db = await fresh();
  await receiveUnit(db, { brand: "Whirlpool", model: "WRF535SDHZ" });
  await receiveUnit(db, { brand: "Samsung", model: "RF28R7351" });
  await receiveUnit(db, { brand: "Samsung", model: "WF45T6000" });

  assert.equal((await listUnits(db, { query: "10000" })).length, 1);
  assert.equal((await listUnits(db, { query: "samsung" })).length, 2);
  assert.equal((await listUnits(db, { query: "WRF535" })).length, 1);
  assert.equal((await listUnits(db, { query: "nothing here" })).length, 0);
  await db.close();
});

test("reports count stock, money tied up, sold this week and aging", async () => {
  const db = await fresh();
  const at = new Date("2026-03-01T12:00:00.000Z");

  const a = await receiveUnit(db, { brand: "A", acquisitionCostCents: 10000, askCents: 25000 });
  const b = await receiveUnit(db, { brand: "B", acquisitionCostCents: 5000, askCents: 12000 });
  const c = await receiveUnit(db, { brand: "C", acquisitionCostCents: 7000 });

  // Age two of them by hand; received_at is otherwise "now".
  await db.run("UPDATE units SET received_at = ? WHERE sku = ?", ["2025-11-01T00:00:00.000Z", b.sku]);
  await db.run("UPDATE units SET received_at = ? WHERE sku = ?", ["2026-02-20T00:00:00.000Z", c.sku]);

  await sellUnit(db, { sku: a.sku, priceCents: 22000, channel: "floor" });

  const out = await reports(db, at);
  assert.equal(out.inStock, 2, "the sold one is no longer in stock");
  assert.equal(out.moneyTiedUpCents, 12000, "5000 + 7000, the sold unit's cost is out");
  assert.equal(out.askValueCents, 12000, "unpriced units contribute nothing");
  assert.equal(out.soldThisWeek, 1);
  assert.equal(out.soldThisWeekCents, 22000);

  const aged = out.agingBuckets.find((x) => x.label === "90+ days");
  assert.equal(aged?.count, 1, "the November unit is over 90 days old");
  await db.close();
});

// ===========================================================================
// Backup and restore.
// ===========================================================================

test("a backup round-trips every row and puts the guarantees back", async () => {
  const db = await fresh();
  const a = await receiveUnit(db, { brand: "Whirlpool", model: "WRF", askCents: 45000 });
  const b = await receiveUnit(db, { brand: "Makita", model: "XFD" });
  await updateUnit(db, a.sku, { condition: "Good" });
  await sellUnit(db, { sku: b.sku, priceCents: 7500, channel: "ebay" });
  await deleteUnit(db, a.sku);

  const snapshot = await exportSnapshot(db);

  const restored = openNodeDb(":memory:");
  await initDb(restored);
  await restoreSnapshot(restored, snapshot);

  assert.equal((await listUnits(restored, {})).length, 1);
  assert.equal((await salesHistory(restored, {})).length, 1);
  assert.equal((await unitHistory(restored, a.sku)).length, (await unitHistory(db, a.sku)).length);

  const ledger = await restored.all<{ n: number }>("SELECT COUNT(*) AS n FROM sku_ledger");
  assert.equal(Number(ledger[0].n), 2, "the deleted unit's SKU is still spent");
  assert.equal(await nextSku(restored), "10002", "numbering continues past the deleted one");

  // The triggers and the index must be live again after a restore.
  const stillSold = await rejects(() =>
    sellUnit(restored, { sku: b.sku, priceCents: 100, channel: "floor" }),
  );
  assert.ok(stillSold instanceof FloorError, "no-double-sale survived the restore");

  const stillImmutable = await rejects(() => restored.run("DELETE FROM events WHERE id = 1"));
  assert.match(stillImmutable.message, /never deleted/);

  await db.close();
  await restored.close();
});

test("a bad or newer backup file is refused rather than half-applied", async () => {
  const db = await fresh();
  await receiveUnit(db, { brand: "Keep me" });

  assert.match((await rejects(() => restoreSnapshot(db, { nope: true }))).message, /not a Floor backup/);
  assert.match(
    (await rejects(() => restoreSnapshot(db, { format: "floor-backup", schemaVersion: 99 }))).message,
    /newer version/,
  );

  assert.equal((await listUnits(db, {})).length, 1, "the refused restore changed nothing");
  await db.close();
});
