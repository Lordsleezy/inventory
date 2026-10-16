import assert from "node:assert/strict";
import { isDeliverableEmail, filterDeliverableEmails } from "./mail.mjs";

assert.equal(isDeliverableEmail("obitracking@gmail.com"), true);
assert.equal(isDeliverableEmail("pgg124@gmail.com"), true);
assert.equal(isDeliverableEmail("local@employees.floor.local"), false);
assert.equal(isDeliverableEmail("1111@staff.floor.local"), false);
assert.equal(isDeliverableEmail("test@example.local"), false);
assert.equal(isDeliverableEmail("nobody@localhost"), false);
assert.equal(isDeliverableEmail("not-an-email"), false);
assert.equal(isDeliverableEmail(""), false);
assert.deepEqual(
  filterDeliverableEmails(["pgg124@gmail.com", "local@employees.floor.local", "obitracking@gmail.com"]),
  ["pgg124@gmail.com", "obitracking@gmail.com"],
);

console.log("mail.test.mjs ok");
