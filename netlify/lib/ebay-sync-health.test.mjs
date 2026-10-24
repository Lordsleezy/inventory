import test from "node:test";
import assert from "node:assert/strict";
import { EBAY_SYNC_LOCK_SECONDS, EBAY_SYNC_STALL_MS, syncCompletedAt, syncNeedsStallEmail } from "./ebay-sync-health.mjs";

test("the ebay-sync lock expires in 10 minutes and the stall mail waits 30", () => {
  assert.equal(EBAY_SYNC_LOCK_SECONDS, 600);
  assert.equal(EBAY_SYNC_STALL_MS, 30 * 60 * 1000);
});

test("stall mail fires once per 30 minute gap and uses the newer of the two completion stamps", () => {
  const now = Date.parse("2026-10-22T03:30:00Z");
  const rows = [
    { key: "ebay_sync_completed_at", value: "2026-10-22T02:00:00Z" },
    { key: "ebay_last_sync_at", value: "2026-10-22T03:10:00Z" },
  ];
  const completedAt = syncCompletedAt(rows);
  assert.equal(syncNeedsStallEmail({ completedAt, alertedAt: null, now }), false);
  const old = Date.parse("2026-10-22T02:00:00Z");
  assert.equal(syncNeedsStallEmail({ completedAt: old, alertedAt: null, now }), true);
  assert.equal(syncNeedsStallEmail({ completedAt: old, alertedAt: now - 5 * 60 * 1000, now }), false);
  assert.equal(syncNeedsStallEmail({ completedAt: null, alertedAt: null, now }), true);
});
