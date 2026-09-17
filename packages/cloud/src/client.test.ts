import assert from "node:assert/strict";
import test from "node:test";
import { authErrorMessage } from "./client.ts";

test("authErrorMessage never prints [object Object]", () => {
  assert.equal(authErrorMessage({}), "Something went wrong");
  assert.equal(authErrorMessage({ foo: 1 }), '{"foo":1}');
  assert.equal(authErrorMessage("[object Object]"), "Something went wrong");
});

test("authErrorMessage unwraps PostgREST unique failures into a SKU sentence", () => {
  assert.equal(
    authErrorMessage({
      code: "23505",
      message: 'duplicate key value violates unique constraint "sku_ledger_pkey"',
      details: "Key (sku)=(11203) already exists.",
    }),
    "SKU 11203 was used before and can't be reused.",
  );
  assert.equal(
    authErrorMessage({ message: "SKU 11203 was used before and can't be reused." }),
    "SKU 11203 was used before and can't be reused.",
  );
});
