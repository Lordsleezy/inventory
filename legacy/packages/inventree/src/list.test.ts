import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeList, recordId } from "./list.ts";

test("raw array is a complete list with no next page", () => {
  const page = normalizeList([{ pk: 1 }, { pk: 2 }]);
  assert.equal(page.items.length, 2);
  assert.equal(page.next, null);
  assert.equal(page.items[0].pk, 1);
});

test("paginated { results, next } keeps items and the next URL", () => {
  const page = normalizeList({
    count: 40,
    next: "http://127.0.0.1:8000/api/stock/?limit=20&offset=20",
    previous: null,
    results: [{ pk: 1 }, { pk: 2 }],
  });
  assert.equal(page.items.length, 2);
  assert.equal(page.next, "http://127.0.0.1:8000/api/stock/?limit=20&offset=20");
});

test("paginated page with next: null is complete", () => {
  const page = normalizeList({ results: [{ id: 9 }], next: null });
  assert.equal(page.items.length, 1);
  assert.equal(page.next, null);
});

test("garbage payload throws instead of looking like an empty warehouse", () => {
  assert.throws(() => normalizeList({ count: 0 }), /Unexpected InvenTree list payload/);
  assert.throws(() => normalizeList(null), /Unexpected InvenTree list payload/);
  assert.throws(() => normalizeList("nope"), /Unexpected InvenTree list payload/);
});

test("recordId prefers pk then id", () => {
  assert.equal(recordId({ pk: 4 }), 4);
  assert.equal(recordId({ id: 7 }), 7);
  assert.throws(() => recordId({}), /no pk\/id/);
});
