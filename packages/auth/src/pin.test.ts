import assert from "node:assert/strict";
import { test } from "node:test";
import { generateInventreePassword, hashPin, isPin, verifyPin } from "./pin.ts";
import { unlockWithPin, upsertStaff, type StaffFile } from "./staff.ts";

test("PIN is 4–8 digits and is not the InvenTree password", () => {
  assert.equal(isPin("1234"), true);
  assert.equal(isPin("12"), false);
  const password = generateInventreePassword();
  assert.ok(password.length >= 16);
  assert.notEqual(password, "1234");
});

test("PIN hash verifies, wrong PIN fails", () => {
  const stored = hashPin("1234");
  assert.equal(verifyPin("1234", stored), true);
  assert.equal(verifyPin("0000", stored), false);
});

test("staff unlock maps PIN to generated InvenTree password", () => {
  const file: StaffFile = { staff: [] };
  const created = upsertStaff(file, {
    username: "alex",
    displayName: "Alex",
    role: "staff",
    pin: "1357",
  });
  assert.ok(created.inventreePassword.length >= 16);
  assert.equal(unlockWithPin(file, "alex", "1357")?.inventreePassword, created.inventreePassword);
  assert.equal(unlockWithPin(file, "alex", "0000"), null);
});
