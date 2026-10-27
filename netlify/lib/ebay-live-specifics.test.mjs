import test from "node:test";
import assert from "node:assert/strict";
import { liveSpecificsForUnit, normalizeLiveAspects } from "./ebay-live-specifics.mjs";

test("live aspects are read from the Inventory API item", async () => {
  const got = await liveSpecificsForUnit("s", "1", {
    inspect: async () => ({ floorStatus: "listed", categoryId: 123, listingId: "820", rawAspects: { Brand: ["Acme"], Type: ["Steamer"], Empty: [""] } }),
    trading: async () => { throw new Error("trading must not be called when the inventory item has aspects"); },
  });
  assert.deepEqual(got, { categoryId: "123", aspects: { Brand: ["Acme"], Type: ["Steamer"] } });
});

test("older Trading listings are read with GetItem", async () => {
  const got = await liveSpecificsForUnit("s", "1", {
    inspect: async () => ({ floorStatus: "listed", categoryId: null, listingId: "820244217131", rawAspects: {} }),
    trading: async (id) => { assert.equal(id, "820244217131"); return { categoryId: "456", aspects: { Color: ["Red"] } }; },
  });
  assert.deepEqual(got, { categoryId: "456", aspects: { Color: ["Red"] } });
});

test("units that are not live on eBay are skipped", async () => {
  assert.equal(await liveSpecificsForUnit("s", "1", { inspect: async () => ({ floorStatus: "delisted", rawAspects: { A: ["b"] } }) }), null);
  assert.deepEqual(normalizeLiveAspects({ A: " x ", B: [], C: null }), { A: ["x"] });
});
