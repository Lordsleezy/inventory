import assert from "node:assert/strict";
import test from "node:test";
import { redact, runTrace, setTrace, currentTrace } from "./floor-log.mjs";

test("redact strips tokens and secrets but keeps sku and condition", () => {
  const out = redact({
    sku: "11116",
    condition: "USED",
    Authorization: "Bearer abc",
    access_token: "xyz",
    refresh_token: "r",
    nested: { client_secret: "nope", categoryId: "20713" },
  });
  assert.equal(out.sku, "11116");
  assert.equal(out.condition, "USED");
  assert.equal(out.Authorization, "[redacted]");
  assert.equal(out.access_token, "[redacted]");
  assert.equal(out.refresh_token, "[redacted]");
  assert.equal(out.nested.client_secret, "[redacted]");
  assert.equal(out.nested.categoryId, "20713");
});

test("trace context carries sku into nested work", async () => {
  await runTrace({ source: "ebay-list", storeId: "store-1" }, async () => {
    setTrace({ sku: "11123" });
    const cur = currentTrace();
    assert.equal(cur.source, "ebay-list");
    assert.equal(cur.sku, "11123");
    assert.equal(cur.storeId, "store-1");
    assert.ok(cur.traceId);
  });
});
