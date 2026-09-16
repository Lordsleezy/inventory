import assert from "node:assert/strict";
import { test } from "node:test";
import { floorStateFromStatus, statusForFloorState, STOCK_STATUS } from "./status.ts";

test("the status table maps every known code", () => {
  assert.equal(floorStateFromStatus(STOCK_STATUS.OK, false).state, "available");
  assert.equal(floorStateFromStatus(STOCK_STATUS.OK, true).state, "reserved");
  assert.equal(floorStateFromStatus(STOCK_STATUS.ATTENTION, false).state, "repair");
  assert.equal(floorStateFromStatus(STOCK_STATUS.DAMAGED, false).state, "repair");
  assert.equal(floorStateFromStatus(STOCK_STATUS.DESTROYED, false).state, "scrapped");
  assert.equal(floorStateFromStatus(STOCK_STATUS.REJECTED, false).state, "voided");
  assert.equal(floorStateFromStatus(STOCK_STATUS.LOST, false).state, "lost");
  assert.equal(floorStateFromStatus(STOCK_STATUS.QUARANTINED, false).state, "repair");
  assert.equal(floorStateFromStatus(STOCK_STATUS.RETURNED, false).state, "available");
  assert.equal(floorStateFromStatus(STOCK_STATUS.RETURNED, true).state, "reserved");
});

test("void writes REJECTED 65, scrap writes DESTROYED 60", () => {
  assert.equal(statusForFloorState("voided"), 65);
  assert.equal(statusForFloorState("scrapped"), 60);
});
