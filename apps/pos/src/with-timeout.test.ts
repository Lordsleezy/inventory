import { test } from "node:test";
import assert from "node:assert/strict";
import { withTimeout } from "./with-timeout.ts";

test("returns successful work and preserves failures", async () => {
  assert.equal(await withTimeout(Promise.resolve(42), "timeout"), 42);
  await assert.rejects(withTimeout(Promise.reject(new Error("HTTP 500")), "timeout"), /HTTP 500/);
});

test("a stalled browser or request produces an actionable error", async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), "Browser timed out; copy the link", 5), /Browser timed out; copy the link/);
});
