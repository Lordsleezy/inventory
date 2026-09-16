import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRequiredSettings } from "./settings.mjs";

const settings = [
  { key: "SERIAL_NUMBER_GLOBALLY_UNIQUE", name: "Globally Unique Serials", value: false },
  { key: "STOCK_ALLOW_DELETE_SERIALIZED", name: "Delete Serialized Stock", value: true },
  { key: "STOCK_OWNERSHIP_CONTROL", name: "Ownership Control", value: false },
  { key: "ALLOW_EDIT_SERIAL", name: "Allow Edit Serial Number", value: true },
];

test("resolves known keys from a live-shaped settings list", () => {
  const resolved = resolveRequiredSettings(settings);
  assert.equal(resolved.unique.key, "SERIAL_NUMBER_GLOBALLY_UNIQUE");
  assert.equal(resolved.deleteSerialized.key, "STOCK_ALLOW_DELETE_SERIALIZED");
  assert.equal(resolved.editSerial.key, "ALLOW_EDIT_SERIAL");
});

test("does not invent SERIAL_NUMBER_AUTOGeneration", () => {
  const resolved = resolveRequiredSettings(settings);
  assert.notEqual(resolved.unique.key, "INVENTREE_SERIAL_NUMBER_AUTOGeneration");
  assert.ok(!Object.values(resolved).some((row) => row?.key?.includes("AUTOGeneration")));
});
