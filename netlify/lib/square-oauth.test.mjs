import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "square/legacy";
import { exchangeSquareCode } from "./square.mjs";
import { squareOAuthFailure } from "./square-oauth-error.mjs";

test("exchange sends all OAuth fields and reports the correct environment without secrets", async (t) => {
  const original = { ...process.env };
  t.after(() => { process.env = original; });
  Object.assign(process.env, {
    SQUARE_APPLICATION_ID: "sq0idp-test",
    SQUARE_APPLICATION_SECRET: "sq0csp-secret",
    SQUARE_REDIRECT_URL: "https://inventoryobi.netlify.app/.netlify/functions/square-oauth-callback",
  });
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  t.mock.method(Object.getPrototypeOf(new Client().oAuthApi), "obtainToken", async (body) => {
    assert.deepEqual(body, {
      clientId: "sq0idp-test", clientSecret: "sq0csp-secret", code: "sq0cgp-code",
      grantType: "authorization_code", redirectUri: process.env.SQUARE_REDIRECT_URL,
    });
    throw Object.assign(new Error("Response status code was not ok: 401."), {
      statusCode: 401,
      body: JSON.stringify({ errors: [{ code: "UNAUTHORIZED", detail: "Invalid client secret sq0csp-secret for sq0cgp-code" }], access_token: "sensitive" }),
    });
  });
  for (const [environment, host] of [["production", "connect.squareup.com"], ["sandbox", "connect.squareupsandbox.com"]]) {
    process.env.SQUARE_ENVIRONMENT = environment;
    await assert.rejects(exchangeSquareCode("sq0cgp-code"), (err) => {
      assert.ok(err.message.includes(`${host}/oauth2/token, HTTP 401`));
      assert.match(err.message, /UNAUTHORIZED: Invalid client secret/);
      assert.doesNotMatch(err.message, /sq0csp-secret|sq0cgp-code|sensitive/);
      return true;
    });
  }
  assert.doesNotMatch(JSON.stringify(logs), /sq0csp-secret|sq0cgp-code|sensitive/);
  assert.equal(logs.length, 2);
});

test("legacy OAuth error bodies expose Square's explanation", (t) => {
  t.mock.method(console, "error", () => {});
  const err = squareOAuthFailure({ statusCode: 401, body: '{"error":"invalid_client","error_description":"Client authentication failed"}' }, "https://connect.squareup.com/oauth2/token");
  assert.match(err.message, /invalid_client: Client authentication failed/);
});
