import assert from "node:assert/strict";
import test from "node:test";
import { amazonConnectAllowed } from "./index.ts";

test("Amazon Individual has no Connect button", () => {
  assert.equal(amazonConnectAllowed("individual"), false);
  assert.equal(amazonConnectAllowed("professional"), true);
});
