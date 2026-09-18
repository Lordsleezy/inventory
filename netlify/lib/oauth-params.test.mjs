import assert from "node:assert/strict";
import test from "node:test";
import { paramsFromNetlifyEvent, parseOAuthCallbackHref } from "./oauth-params.mjs";

test("rebuilds eBay code and state after the unencoded # fragment", () => {
  const href =
    "https://inventoryobi.netlify.app/.netlify/functions/oauth-callback?code=v^1.1#r^1#i^1#p^3#I^3#f^0#t^H4sI&expires_in=299&state=deadbeef";
  const parsed = parseOAuthCallbackHref(href);
  assert.equal(parsed.state, "deadbeef");
  assert.equal(parsed.code, "v^1.1#r^1#i^1#p^3#I^3#f^0#t^H4sI");
});

test("reads query when eBay URL-encodes the code", () => {
  const href =
    "https://inventoryobi.netlify.app/.netlify/functions/oauth-callback?code=v%5E1.1%23r%5E1&state=abc";
  const parsed = parseOAuthCallbackHref(href);
  assert.equal(parsed.state, "abc");
  assert.equal(parsed.code, "v^1.1#r^1");
});

test("reads POST body when query string is empty", () => {
  const parsed = paramsFromNetlifyEvent({
    httpMethod: "POST",
    queryStringParameters: {},
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "code=tok&state=nonce",
  });
  assert.equal(parsed.code, "tok");
  assert.equal(parsed.state, "nonce");
});
