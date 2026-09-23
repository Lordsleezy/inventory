import assert from "node:assert/strict";
import test from "node:test";
import { mapChargeStatus, readerIsFresh } from "./card-status.ts";

test("reader heartbeat is stale after 45 seconds", () => {
  const now = Date.parse("2026-09-19T18:00:00Z");
  assert.equal(readerIsFresh(new Date(now - 5_000).toISOString(), now), true);
  assert.equal(readerIsFresh(new Date(now - 46_000).toISOString(), now), false);
  assert.equal(readerIsFresh(null, now), false);
});

test("captured with payment id is success; decline and cancel are not retried as success", () => {
  assert.equal(mapChargeStatus("captured", "sq_1").ok, true);
  assert.deepEqual(mapChargeStatus("failed", null), { ok: false, reason: "failed" });
  assert.deepEqual(mapChargeStatus("canceled", null), { ok: false, reason: "canceled" });
});
