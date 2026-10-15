import assert from "node:assert/strict";
import test from "node:test";
import { redact, runTrace, setTrace, currentTrace, asNetlifyFunction, netlifyHandler } from "./floor-log.mjs";

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

test("modern entrypoint turns a Request into a Lambda event and a Response back", async () => {
  const body = JSON.stringify({ next_run: "2026-10-15T00:00:00.000Z" });
  const fn = asNetlifyFunction(async (event) => {
    assert.equal(event.httpMethod, "POST");
    assert.equal(event.body, body);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  });
  const res = await fn(new Request("https://inventoryobi.netlify.app/.netlify/functions/example", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }), {});
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("empty 204 lambda result becomes a real 204 response", async () => {
  const fn = asNetlifyFunction(async () => ({ statusCode: 204, body: "" }));
  const res = await fn(new Request("https://example.com/deletion"), {});
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
});

test("OPTIONS skips logging and still returns through the modern runtime", async () => {
  const fn = netlifyHandler("example", async (event) => {
    assert.equal(event.httpMethod, "OPTIONS");
    return { statusCode: 200, body: "" };
  });
  const res = await fn(new Request("https://example.com/example", { method: "OPTIONS" }), {});
  assert.equal(res.status, 200);
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
