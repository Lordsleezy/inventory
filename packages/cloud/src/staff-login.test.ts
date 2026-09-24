import assert from "node:assert/strict";
import test from "node:test";
import { clockLoginEmail, clockRuleError, loginEmailFromIdentifier, pinRuleError, authSecretFromLogin } from "./staff-login.ts";

test("clock numbers map to the same synthetic email the login screen uses", () => {
  assert.equal(clockLoginEmail("1111"), "1111@staff.floor.local");
  assert.equal(loginEmailFromIdentifier("1111"), "1111@staff.floor.local");
  assert.equal(loginEmailFromIdentifier("  Pat@Store.COM "), "pat@store.com");
  assert.equal(authSecretFromLogin("1111", "7291"), "floor7291");
  assert.equal(authSecretFromLogin("owner@store.com", "LongerPass"), "LongerPass");
});

test("clock 1111 is allowed; Password and 1111-as-PIN are not", () => {
  assert.equal(clockRuleError("1111"), null);
  assert.match(String(pinRuleError("Password", "1111")), /digits/);
  assert.match(String(pinRuleError("1111", "1111")), /same as the clock/);
  assert.match(String(pinRuleError("0000", "1111")), /same digit/);
  assert.match(String(pinRuleError("1234", "1111")), /straight run/);
  assert.equal(pinRuleError("7291", "1111"), null);
});
