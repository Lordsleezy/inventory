import test from "node:test";
import assert from "node:assert/strict";
import { parseSquareNotification, squareSignature, verifySquareSignature } from "./square-webhook.mjs";

test("Square webhook signature is the notification URL plus the raw body", () => {
  const key = "square-signature-key";
  const url = "https://inventoryobi.netlify.app/.netlify/functions/square-webhook";
  const body = JSON.stringify({ event_id: "evt", type: "refund.updated" });
  const signature = squareSignature(key, url, body);
  assert.equal(verifySquareSignature(key, url, body, signature), true);
  assert.equal(verifySquareSignature(key, url, body + " ", signature), false);
  assert.equal(verifySquareSignature(key, "https://evil.example/square-webhook", body, signature), false);
  assert.equal(verifySquareSignature("", url, body, signature), false);
});

test("Square refund and dispute notifications keep the payment id", () => {
  const refund = parseSquareNotification({
    merchant_id: "M",
    type: "refund.updated",
    event_id: "evt-refund",
    data: { type: "refund", id: "ref_1", object: { refund: {
      id: "ref_1", status: "COMPLETED", payment_id: "pay_1", amount_money: { amount: 2500, currency: "USD" },
    } } },
  });
  assert.equal(refund.kind, "refund");
  assert.equal(refund.status, "COMPLETED");
  assert.equal(refund.amountCents, 2500);
  assert.equal(refund.paymentId, "pay_1");

  const dispute = parseSquareNotification({
    type: "dispute.created",
    event_id: "evt-dispute",
    data: { type: "dispute", id: "disp_1", object: { dispute: {
      dispute_id: "disp_1", state: "EVIDENCE_REQUIRED", reason: "NO_KNOWLEDGE",
      amount_money: { amount: 900, currency: "USD" },
      disputed_payment: { payment_id: "pay_9" },
    } } },
  });
  assert.equal(dispute.kind, "dispute");
  assert.equal(dispute.paymentId, "pay_9");
  assert.equal(parseSquareNotification({ type: "payment.updated", event_id: "evt-pay" }), null);
});
