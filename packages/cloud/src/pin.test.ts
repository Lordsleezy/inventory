import assert from "node:assert/strict";
import test from "node:test";
import { nextPinState, pinIsLocked, PIN_LOCK_MINUTES, PIN_MAX_FAILURES } from "./pin.ts";

test("manager PIN locks after five wrong tries", () => {
  const t0 = 1_000_000;
  let failed = 0;
  let locked: number | null = null;
  for (let i = 1; i <= PIN_MAX_FAILURES; i += 1) {
    const next = nextPinState(failed, false, t0);
    failed = next.failedCount;
    locked = next.lockedUntilMs;
    if (i < PIN_MAX_FAILURES) assert.equal(locked, null);
  }
  assert.equal(failed, 5);
  assert.equal(locked, t0 + PIN_LOCK_MINUTES * 60_000);
  assert.equal(pinIsLocked(locked, t0 + 60_000), true);
  assert.equal(pinIsLocked(locked, t0 + PIN_LOCK_MINUTES * 60_000 + 1), false);
});

test("a correct PIN clears the lockout counter", () => {
  const next = nextPinState(4, true, 0);
  assert.equal(next.failedCount, 0);
  assert.equal(next.lockedUntilMs, null);
});
