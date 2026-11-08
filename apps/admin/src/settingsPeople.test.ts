import assert from "node:assert/strict";
import test from "node:test";
import { peopleForCommission, showsOnPayouts } from "./settingsPeople.ts";

const steve = { user_id: "s", display_name: "Steve" };
const paul = { user_id: "p", display_name: "Paul" };
const jacobPaid = { user_id: "j1", display_name: "Jacob" };
const jacobEmpty = { user_id: "j2", display_name: "Jacob" };
const admin = { user_id: "a", display_name: "Admin" };

test("commission split keeps one row per name and leaves out the protected admin", () => {
  const emails = new Map<string, string>([
    ["s", "steve@store.test"],
    ["p", "paul@store.test"],
    ["j1", "jacob@store.test"],
    ["j2", "jacob2@store.test"],
    ["a", "admin@admin.com"],
  ]);
  const rows = peopleForCommission(
    [admin, jacobEmpty, steve, jacobPaid, paul],
    [{ employee_id: "j1", rate: 10 }, { employee_id: "p", rate: 20 }],
    emails,
  );
  assert.deepEqual(rows.map((row) => row.user_id), ["s", "p", "j1"]);
});

test("a person with no commission stays off the payout screen", () => {
  assert.equal(showsOnPayouts("s", [{ employee_id: "s", rate: 0 }], null), false);
  assert.equal(showsOnPayouts("p", [{ employee_id: "p", rate: 20 }], null), true);
  assert.equal(showsOnPayouts("online", [], "online"), true);
});
