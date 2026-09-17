import assert from "node:assert/strict";
import test from "node:test";
import { initDb } from "@floor/store";
import { openNodeDb } from "../../store/src/driver-node.ts";
import { applyCachePayload, type CachePayload } from "./hydrate.ts";

async function fresh() {
  const db = openNodeDb(":memory:");
  await initDb(db);
  return db;
}

const emptyStore: CachePayload = {
  includeCost: true,
  ledger: [],
  units: [],
  sales: [],
  photos: [],
  events: [
    {
      id: 1,
      at: "2026-09-16T00:00:00.000Z",
      sku: null,
      kind: "store_created",
      actor: "Pat",
      note: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    },
    {
      id: 2,
      at: "2026-09-16T00:00:01.000Z",
      sku: "not-a-sku",
      kind: "staff_invited",
      actor: "Pat",
      note: "invited",
    },
  ],
};

const stockedStore: CachePayload = {
  includeCost: true,
  ledger: [
    { sku: "10421", issued_at: "2026-09-01T00:00:00.000Z", label: "", fate: "issued" },
    { sku: "10422", issued_at: "2026-09-02T00:00:00.000Z", label: "", fate: "sold" },
  ],
  units: [
    {
      sku: "10421",
      brand: "GE",
      model: "GTS18",
      title: "Fridge",
      ask_cents: 8900,
      acquisition_cost_cents: 4000,
      floor_cents: 5000,
      state: "available",
      received_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
    },
    {
      sku: "10422",
      brand: "DeWalt",
      model: "DCD771",
      title: "Drill",
      ask_cents: 4500,
      acquisition_cost_cents: 2000,
      floor_cents: 2500,
      state: "sold",
      received_at: "2026-09-02T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z",
    },
  ],
  sales: [
    {
      id: 9,
      sku: "10422",
      price_cents: 4500,
      channel: "floor",
      payment_method: "cash",
      sold_at: "2026-09-03T00:00:00.000Z",
      receipt_no: "R-10422",
      voided_at: null,
    },
  ],
  photos: [
    {
      id: 3,
      sku: "10421",
      path: "store/10421/a.jpg",
      created_at: "2026-09-01T00:00:00.000Z",
      is_primary: true,
    },
  ],
  events: [
    { id: 1, at: "2026-09-01T00:00:00.000Z", sku: null, kind: "store_created", actor: "Pat" },
    { id: 2, at: "2026-09-01T00:01:00.000Z", sku: "10421", kind: "received", actor: "Pat" },
    { id: 3, at: "2026-09-03T00:00:00.000Z", sku: "10422", kind: "sold", actor: "Pat" },
    { id: 4, at: "2026-09-03T00:01:00.000Z", sku: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee", kind: "staff_invited", actor: "Pat" },
  ],
};

test("hydrate of an empty store does not trip FKs or unique ids", async () => {
  const db = await fresh();
  await applyCachePayload(db, emptyStore);
  await applyCachePayload(db, emptyStore);
  const units = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM units");
  const events = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM events");
  const storeEvents = await db.all<{ sku: string | null; kind: string }>(
    "SELECT sku, kind FROM events ORDER BY id",
  );
  assert.equal(Number(units[0]?.n), 0);
  assert.equal(Number(events[0]?.n), 2);
  assert.equal(storeEvents[0]?.kind, "store_created");
  assert.equal(storeEvents[0]?.sku, null);
  assert.equal(storeEvents[1]?.sku, null);
  await db.close();
});

test("hydrate of a stocked store inserts ledger then units, sales, photos, events", async () => {
  const db = await fresh();
  await applyCachePayload(db, stockedStore);
  await applyCachePayload(db, stockedStore);

  const ledger = await db.all<{ sku: string }>("SELECT sku FROM sku_ledger ORDER BY sku");
  const units = await db.all<{ sku: string; state: string; acquisition_cost_cents: number | null }>(
    "SELECT sku, state, acquisition_cost_cents FROM units ORDER BY sku",
  );
  const sales = await db.all<{ sku: string; receipt_no: string }>("SELECT sku, receipt_no FROM sales");
  const photos = await db.all<{ sku: string }>("SELECT sku FROM photos");
  const events = await db.all<{ sku: string | null; kind: string }>(
    "SELECT sku, kind FROM events ORDER BY id",
  );

  assert.deepEqual(ledger.map((r) => r.sku), ["10421", "10422"]);
  assert.equal(units.length, 2);
  assert.equal(units[0]?.acquisition_cost_cents, 4000);
  assert.equal(units[1]?.state, "sold");
  assert.equal(sales[0]?.receipt_no, "R-10422");
  assert.equal(photos.length, 1);
  assert.equal(events.length, 4);
  assert.equal(events.find((e) => e.kind === "store_created")?.sku, null);
  assert.equal(events.find((e) => e.kind === "staff_invited")?.sku, null);
  assert.equal(events.find((e) => e.kind === "received")?.sku, "10421");
  await db.close();
});

test("staff hydrate strips cost even when the payload includes it", async () => {
  const db = await fresh();
  await applyCachePayload(db, { ...stockedStore, includeCost: false });
  const rows = await db.all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM units WHERE acquisition_cost_cents IS NOT NULL OR floor_cents IS NOT NULL",
  );
  assert.equal(Number(rows[0]?.n), 0);
  await db.close();
});

test("hydrate preserves cloud sale ids so void can target the live row", async () => {
  const db = await fresh();
  await applyCachePayload(db, stockedStore);
  const sales = await db.all<{ id: number }>("SELECT id FROM sales");
  assert.equal(Number(sales[0]?.id), 9);
  await db.close();
});

test("hydrate sold then voided then deleted without FK or unique errors", async () => {
  const db = await fresh();
  await applyCachePayload(db, stockedStore);

  const voided: CachePayload = {
    ...stockedStore,
    ledger: [
      { sku: "10421", issued_at: "2026-09-01T00:00:00.000Z", label: "", fate: "issued" },
      { sku: "10422", issued_at: "2026-09-02T00:00:00.000Z", label: "", fate: "issued" },
    ],
    units: [stockedStore.units[0]!, { ...stockedStore.units[1]!, state: "available" }],
    sales: [
      {
        ...stockedStore.sales[0],
        voided_at: "2026-09-04T00:00:00.000Z",
        void_reason: "customer changed mind",
      },
    ],
    events: [
      ...stockedStore.events,
      { id: 5, at: "2026-09-04T00:00:00.000Z", sku: "10422", kind: "sale_void", actor: "Pat" },
    ],
  };
  await applyCachePayload(db, voided);
  const afterVoid = await db.all<{ state: string }>("SELECT state FROM units WHERE sku = '10422'");
  const voidSale = await db.all<{ voided_at: string | null }>("SELECT voided_at FROM sales WHERE id = 9");
  assert.equal(afterVoid[0]?.state, "available");
  assert.ok(voidSale[0]?.voided_at);

  const deleted: CachePayload = {
    includeCost: true,
    ledger: [
      { sku: "10421", issued_at: "2026-09-01T00:00:00.000Z", label: "", fate: "issued" },
      { sku: "10422", issued_at: "2026-09-02T00:00:00.000Z", label: "", fate: "hard-deleted" },
    ],
    units: [stockedStore.units[0]!],
    sales: voided.sales,
    photos: stockedStore.photos,
    events: [
      ...voided.events!,
      { id: 6, at: "2026-09-05T00:00:00.000Z", sku: "10422", kind: "deleted", actor: "Pat" },
    ],
  };
  await applyCachePayload(db, deleted);
  await applyCachePayload(db, deleted);
  const gone = await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM units WHERE sku = '10422'");
  const fate = await db.all<{ fate: string }>("SELECT fate FROM sku_ledger WHERE sku = '10422'");
  assert.equal(Number(gone[0]?.n), 0);
  assert.equal(fate[0]?.fate, "hard-deleted");
  await db.close();
});
