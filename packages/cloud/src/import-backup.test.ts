import assert from "node:assert/strict";
import test from "node:test";
import { importPhoneBackup, requiredStoreId } from "./import-backup.ts";

const STORE = "11111111-1111-4111-8111-111111111111";

const emptySnap = {
  format: "floor-backup",
  schemaVersion: 1,
  exportedAt: "2026-01-01T00:00:00.000Z",
  counts: {},
  photoPaths: [],
  tables: {
    sku_ledger: [],
    units: [],
    sales: [],
    events: [],
    photos: [],
    settings: [],
  },
};

function chain(result: unknown) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = async () => result;
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

test("import will not create a store — STORE_ID is required", () => {
  const prev = process.env.STORE_ID;
  delete process.env.STORE_ID;
  try {
    assert.throws(() => requiredStoreId(), /will not create a store/);
  } finally {
    if (prev === undefined) delete process.env.STORE_ID;
    else process.env.STORE_ID = prev;
  }
});

test("import refuses when the store already has units", async () => {
  const client = {
    from(table: string) {
      if (table === "stores") return chain({ data: { id: STORE }, error: null });
      if (table === "units") return chain({ data: null, error: null, count: 12 });
      return chain({ data: null, error: null, count: 0 });
    },
  };
  await assert.rejects(
    () => importPhoneBackup(emptySnap, client as never, STORE),
    /already has 12 units/i,
  );
});

test("import refuses a STORE_ID that does not exist", async () => {
  const client = {
    from() {
      return chain({ data: null, error: null });
    },
  };
  await assert.rejects(
    () => importPhoneBackup(emptySnap, client as never, STORE),
    /does not exist/i,
  );
});
