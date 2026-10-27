import { test } from "node:test";
import assert from "node:assert/strict";
import { autoFillUnit, makeDescription } from "./auto-fill.mjs";

function fake(unit = {}, { suggestion = "123", specifics = {}, suggestFails = false } = {}) {
  const calls = { suggest: 0, savedCategory: [], savedDescription: [], marked: [], specifics: 0 };
  const state = { unit: { title: "Acme Desk Lamp", brand: "Acme", model: "L1", condition: "Open box", defect_notes: "", listing_body: "", category_id: null, tried_title: "", ...unit } };
  const deps = {
    loadUnit: async () => state.unit,
    suggest: async () => { calls.suggest++; if (suggestFails) throw new Error("ebay down"); return suggestion; },
    prepareCategory: async () => {},
    saveCategory: async (_s, sku, id) => { calls.savedCategory.push([sku, id]); state.unit.category_id = id; },
    specifics: async () => { calls.specifics++; return { categoryId: state.unit.category_id, missing: [], ...specifics }; },
    saveDescription: async (_s, sku, text) => { calls.savedDescription.push([sku, text]); return true; },
    markTried: async (_s, sku, title) => calls.marked.push([sku, title]),
  };
  return { deps, calls, state };
}

test("description is the same text the Generate description checkbox makes", () => {
  assert.equal(makeDescription({ title: "Acme Desk Lamp", condition: "Open box", defect_notes: "Scuffed base" }, "9"),
    "Acme Desk Lamp.\n\nCondition: Open box.\n\nNotes: Scuffed base.");
  assert.equal(makeDescription({ brand: "Acme", model: "L1" }, "9"), "Acme L1.");
});

test("no category: takes eBay's top suggestion, marks it auto, pre-fills specifics and writes the description", async () => {
  const { deps, calls } = fake();
  const r = await autoFillUnit(deps, "s", "A1");
  assert.deepEqual(calls.savedCategory, [["A1", "123"]]);
  assert.equal(r.category, "set_auto_suggested");
  assert.equal(calls.specifics, 2, "specifics run before and after the category is saved");
  assert.equal(r.description, "set");
  assert.equal(calls.savedDescription[0][1], "Acme Desk Lamp.\n\nCondition: Open box.");
});

test("a category and a description that already exist are never changed", async () => {
  const { deps, calls } = fake({ category_id: "777", listing_body: "My own text" });
  const r = await autoFillUnit(deps, "s", "A1");
  assert.equal(calls.suggest, 0);
  assert.deepEqual(calls.savedCategory, []);
  assert.deepEqual(calls.savedDescription, []);
  assert.equal(r.category, "existing");
  assert.equal(r.description, "existing");
});

test("no suggestion from eBay: category stays blank, is counted, and is not retried until the title changes", async () => {
  const first = fake({}, { suggestion: null });
  const r = await autoFillUnit(first.deps, "s", "A1");
  assert.equal(r.category, "no_suggestion");
  assert.deepEqual(first.calls.savedCategory, []);
  assert.deepEqual(first.calls.marked, [["A1", "Acme Desk Lamp"]]);
  const same = fake({ tried_title: "Acme Desk Lamp" }, { suggestion: "123" });
  assert.equal((await autoFillUnit(same.deps, "s", "A1")).category, "no_suggestion");
  assert.equal(same.calls.suggest, 0);
  const changed = fake({ tried_title: "Old title" }, { suggestion: "123" });
  assert.equal((await autoFillUnit(changed.deps, "s", "A1")).category, "set_auto_suggested");
});

test("an eBay outage is not remembered as 'no suggestion'", async () => {
  const { deps, calls } = fake({}, { suggestFails: true });
  const r = await autoFillUnit(deps, "s", "A1");
  assert.equal(r.category, "suggestion_error");
  assert.deepEqual(calls.marked, []);
});

test("a category that came from Floor's own data is used instead of the title suggestion", async () => {
  const { deps, calls } = fake({}, { specifics: { categoryId: "555", categorySource: "floor_upc_memory", missing: ["Type"] } });
  const r = await autoFillUnit(deps, "s", "A1");
  assert.equal(calls.suggest, 0);
  assert.equal(r.category, "set_floor_upc_memory");
  assert.deepEqual(r.specificsMissing, ["Type"]);
});

test("a unit with eBay turned off keeps its (blank) category row; only the description is written", async () => {
  const { deps, calls } = fake({}, { specifics: { skipped: "ebay_disabled", categoryId: undefined } });
  const r = await autoFillUnit(deps, "s", "A1");
  assert.equal(r.category, "ebay_disabled");
  assert.deepEqual(calls.savedCategory, []);
  assert.equal(r.description, "set");
});

test("dry run writes nothing", async () => {
  const { deps, calls } = fake();
  await autoFillUnit(deps, "s", "A1", { write: false });
  assert.deepEqual(calls.savedCategory, []);
  assert.deepEqual(calls.savedDescription, []);
  assert.deepEqual(calls.marked, []);
});

test("a unit with no title or brand/model gets no made-up description", async () => {
  const { deps } = fake({ title: "", brand: "", model: "", category_id: "1" });
  assert.equal((await autoFillUnit(deps, "s", "A1")).description, "no_name");
});
