import test from "node:test";
import assert from "node:assert/strict";
import {
  mapTikTokReturn,
  suggestTikTokPriceCents,
  signTikTokRequest,
  TIKTOK_DEFAULT_FEE_PCT,
  TIKTOK_OAUTH_REDIRECT,
  TIKTOK_API_SCOPES,
} from "./tiktok-shop.mjs";

test("TikTok mapper marks requested as needs decision", () => {
  const row = mapTikTokReturn({
    return_id: "R1",
    order_id: "O1",
    seller_sku: "11500",
    return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
    refund_amount: 19.5,
    return_reason: "DEFECTIVE",
  });
  assert.equal(row.channel, "tiktok");
  assert.equal(row.sku, "11500");
  assert.equal(row.needs_decision, true);
  assert.equal(row.refund_cents, 1950);
});

test("TikTok readiness price is Floor ask, plus 10% only below $15", () => {
  const unit = { retail_cents: 10000, ask_cents: 6000, acquisition_cost_cents: 900, is_collectible: true };
  const price = suggestTikTokPriceCents(unit, TIKTOK_DEFAULT_FEE_PCT, 10);
  assert.equal(price.listCents, 6000);
  assert.equal(price.returnReservePct, 0);
  assert.ok(price.feeCents > 0);
  assert.equal(suggestTikTokPriceCents({ ask_cents: 1499 }).listCents, 1649);
  assert.equal(suggestTikTokPriceCents({ ask_cents: 1500 }).listCents, 1500);
});

test("signTikTokRequest is stable HMAC", () => {
  process.env.TIKTOK_SHOP_APP_SECRET = "test_secret";
  const a = signTikTokRequest({
    path: "/order/202309/orders/search",
    params: { app_key: "k", timestamp: "1700000000", shop_id: "1" },
    body: '{"page_size":50}',
  });
  const b = signTikTokRequest({
    path: "/order/202309/orders/search",
    params: { shop_id: "1", timestamp: "1700000000", app_key: "k" },
    body: '{"page_size":50}',
  });
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test("docs constants: redirect + scopes", () => {
  assert.match(TIKTOK_OAUTH_REDIRECT, /tiktok-oauth-callback$/);
  assert.ok(TIKTOK_API_SCOPES.some((s) => /order/i.test(s)));
  assert.ok(TIKTOK_API_SCOPES.some((s) => /product/i.test(s)));
  assert.ok(TIKTOK_API_SCOPES.some((s) => /return/i.test(s)));
});
