import assert from "node:assert/strict";
import { test } from "node:test";
import { employeeSignInEmail } from "./employee-login.ts";

test("employee usernames resolve to the synthetic email used by account creation", () => {
  assert.equal(employeeSignInEmail("1111"), "1111@employees.floor.local");
  assert.equal(employeeSignInEmail(" Desk  Lead "), "desk-lead@employees.floor.local");
});
test("employee emails are normalized; malformed identities are rejected", () => {
  assert.equal(employeeSignInEmail(" OWNER@Shop.example "), "owner@shop.example");
  assert.equal(employeeSignInEmail(""), null);
  assert.equal(employeeSignInEmail("bad@@example.com"), null);
});
