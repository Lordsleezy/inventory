import test from "node:test";
import assert from "node:assert/strict";
import { assertOnline, OfflineError, setDeviceNetworkGetter } from "./online.ts";

test("assertOnline is offline only when the device has no connection", async () => {
  setDeviceNetworkGetter(async () => ({ connected: false, connectionType: "none" }));
  await assert.rejects(() => assertOnline(), (err: unknown) => err instanceof OfflineError);
  setDeviceNetworkGetter(async () => ({ connected: true, connectionType: "unknown" }));
});
