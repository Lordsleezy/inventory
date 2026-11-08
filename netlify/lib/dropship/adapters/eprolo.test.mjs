import test from "node:test";
import assert from "node:assert/strict";
import { eproloAdapter } from "./eprolo.mjs";
import { dobaAdapter } from "./doba.mjs";
import { listAdapters, getAdapter } from "./index.mjs";

const METHODS = [
  "testConnection",
  "listCatalog",
  "getProduct",
  "liveStock",
  "shippingEstimate",
  "placeOrder",
  "getTracking",
  "getBalance",
];

test("eprolo exposes the full adapter contract and fails closed", async () => {
  assert.equal(eproloAdapter.enabled, false);
  assert.match(eproloAdapter.statusHint, /waiting/i);
  for (const m of METHODS) assert.equal(typeof eproloAdapter[m], "function");
  const r = await eproloAdapter.testConnection({});
  assert.equal(r.ok, false);
  await assert.rejects(() => eproloAdapter.listCatalog({}, { page: 1 }), /waiting/);
  await assert.rejects(() => eproloAdapter.placeOrder({}, {}), /waiting/);
});

test("doba is disabled and marked unused", async () => {
  assert.equal(dobaAdapter.enabled, false);
  assert.match(dobaAdapter.statusHint, /disabled|unused/i);
  await assert.rejects(() => dobaAdapter.placeOrder({}, {}), /disabled/);
});

test("registry lists cj + stubs", () => {
  const ids = listAdapters().map((a) => a.id).sort();
  assert.deepEqual(ids, ["cj", "doba", "eprolo", "printify"]);
  assert.equal(getAdapter("cj").enabled, true);
});
