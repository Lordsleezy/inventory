import test from "node:test";
import assert from "node:assert/strict";
import { EBAY_LISTING_OAUTH_SCOPES, EBAY_ORDERS_OAUTH_SCOPES, oauthScopesForRole } from "./ebay-env.mjs";

const BASE = "https://api.ebay.com/oauth/api_scope";
const has = (list, scope) => list.split(" ").includes(`${BASE}/${scope}`);

test("store (selling) account asks for sell.finances and keeps every scope it already had, including sell.marketing", () => {
  const scopes = oauthScopesForRole("selling");
  assert.equal(scopes, EBAY_LISTING_OAUTH_SCOPES);
  assert.ok(scopes.split(" ").includes(BASE), "base api_scope");
  for (const s of ["sell.inventory", "sell.fulfillment", "sell.account", "sell.marketing", "commerce.notification.subscription", "sell.finances"]) {
    assert.ok(has(scopes, s), `selling scope ${s}`);
  }
  assert.equal(new Set(scopes.split(" ")).size, scopes.split(" ").length, "no duplicate scopes");
});

test("orders-only account asks for sell.finances too", () => {
  const scopes = oauthScopesForRole("orders_only");
  assert.equal(scopes, EBAY_ORDERS_OAUTH_SCOPES);
  for (const s of ["sell.fulfillment", "sell.account", "sell.finances"]) assert.ok(has(scopes, s), `orders scope ${s}`);
});
