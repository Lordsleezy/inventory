import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyTikTokWebhookSignature } from "../lib/tiktok-webhook-signature.mjs";

test("TikTok webhook verifies app-key plus raw-body HMAC and rejects invalid signatures", () => {
  const key = "test-app-key";
  const secret = "test-app-secret";
  const body = '{"type":"ORDER_STATUS_CHANGE","data":{"order_id":"123"}}';
  const signature = createHmac("sha256", secret).update(`${key}${body}`).digest("hex");
  assert.equal(verifyTikTokWebhookSignature(body, signature, key, secret), true);
  assert.equal(verifyTikTokWebhookSignature(body, "bad", key, secret), false);
  assert.equal(verifyTikTokWebhookSignature(`${body} `, signature, key, secret), false);
});
