import assert from "node:assert/strict";
import { test } from "node:test";
import { assertInspectFields, parseFloorConfig } from "./config.ts";
import { marketplaceNavAllowed } from "./marketplace.ts";

test("marketplace.unrestricted defaults true", () => {
  assert.equal(parseFloorConfig({}).marketplace.unrestricted, true);
  assert.equal(parseFloorConfig({ marketplace: { unrestricted: false } }).marketplace.unrestricted, false);
});

test("inspect fields must come from config lists", () => {
  const config = parseFloorConfig({});
  assertInspectFields(config, { condition: "Good", testStatus: "passed" });
  assert.throws(() => assertInspectFields(config, { condition: "mint", testStatus: "passed" }), /Condition/);
  assert.throws(() => assertInspectFields(config, { condition: "Good", testStatus: "ok" }), /Test status/);
  assertInspectFields(config, { condition: null, testStatus: "untested" });
});

test("unrestricted marketplace allows any https host", () => {
  assert.equal(marketplaceNavAllowed("https://example.com/x", { unrestricted: true, channel: "ebay" }), true);
  assert.equal(marketplaceNavAllowed("https://www.ebay.com/itm/1", { unrestricted: false, channel: "ebay" }), true);
  assert.equal(marketplaceNavAllowed("https://example.com/x", { unrestricted: false, channel: "ebay" }), false);
});
