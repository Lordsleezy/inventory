import assert from "node:assert/strict";
import test from "node:test";
import {
  conditionsNeedRefresh,
  gradeMapForCategory,
  listingConditionPayload,
  mapFloorCondition,
} from "./ebay-conditions.mjs";

const APPLIANCE = [
  { conditionId: "1000", name: "New" },
  { conditionId: "1500", name: "Open box" },
  { conditionId: "3000", name: "Used" },
  { conditionId: "7000", name: "For parts or not working" },
];

const ELECTRONICS = [
  { conditionId: "1000", name: "New" },
  { conditionId: "1500", name: "Open box" },
  { conditionId: "2500", name: "Seller refurbished" },
  { conditionId: "3000", name: "Used" },
  { conditionId: "7000", name: "For parts or not working" },
];

test("appliance categories map Floor grades onto New / Open box / Used / For parts", () => {
  assert.equal(mapFloorCondition("New", APPLIANCE).conditionId, "1000");
  assert.equal(mapFloorCondition("Open box", APPLIANCE).conditionId, "1500");
  assert.equal(mapFloorCondition("Excellent", APPLIANCE).conditionId, "3000");
  assert.equal(mapFloorCondition("Very good", APPLIANCE).conditionId, "3000");
  assert.equal(mapFloorCondition("Good", APPLIANCE).conditionId, "3000");
  assert.equal(mapFloorCondition("Fair", APPLIANCE).conditionId, "3000");
  assert.equal(mapFloorCondition("For parts", APPLIANCE).conditionId, "7000");
});

test("used and defective Floor grades never map to New, Open box, or Refurbished", () => {
  for (const grade of ["Excellent", "Very good", "Good", "Fair", "For parts"]) {
    const mapped = mapFloorCondition(grade, ELECTRONICS);
    assert.ok(mapped);
    assert.notEqual(mapped.conditionId, "1000");
    assert.notEqual(mapped.conditionId, "1500");
    assert.notEqual(mapped.conditionId, "2500");
  }
  assert.equal(mapFloorCondition("For parts", ELECTRONICS).conditionId, "7000");
  assert.equal(mapFloorCondition("Excellent", ELECTRONICS).name, "Used");
});

test("For parts is unmapped when the category has no parts condition", () => {
  const allowed = [
    { conditionId: "1000", name: "New" },
    { conditionId: "3000", name: "Used" },
  ];
  assert.equal(mapFloorCondition("For parts", allowed), null);
  assert.equal(mapFloorCondition("Excellent", allowed).conditionId, "3000");
});

test("listing payload sends the category condition id, not a global enum", () => {
  const mapped = mapFloorCondition("Excellent", APPLIANCE);
  assert.deepEqual(listingConditionPayload(mapped), { conditionId: "3000" });
});

test("grade map reports closest Used for mid grades on appliances", () => {
  const rows = gradeMapForCategory(APPLIANCE);
  assert.equal(rows.find((r) => r.floor === "Open box").ebayName, "Open box");
  assert.equal(rows.find((r) => r.floor === "Fair").ebayName, "Used");
  assert.equal(rows.every((r) => !r.unmapped), true);
});

test("condition catalogs refresh when eBay adds or renames IDs", () => {
  assert.equal(conditionsNeedRefresh(APPLIANCE, APPLIANCE), false);
  assert.equal(
    conditionsNeedRefresh(APPLIANCE, [...APPLIANCE, { conditionId: "2500", name: "Seller refurbished" }]),
    true,
  );
});
